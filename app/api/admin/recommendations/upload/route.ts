import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { parseCsv, splitList } from '@/lib/utils/csv';

// Admin CSV upload — the "edit content without a deployment" path. Column
// headers must match the same 4 file formats already established (Master /
// Conditions / Calculation Methods / Placeholders CSVs) so a spreadsheet
// maintained offline can be re-uploaded directly. Behavior is upsert-by-code:
// rows with a matching code are updated in place, new codes are inserted,
// and codes NOT present in the uploaded file are left untouched.
type FileType = 'master' | 'conditions' | 'calculation_methods' | 'placeholders';

function toBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim().toLowerCase() === 'true';
}
function toInt(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}
function toNullable(v: string | undefined): string | null {
  return v && v.trim() !== '' ? v.trim() : null;
}

export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const fileType = body.fileType as FileType;
  const csvText = body.csvText as string;
  if (!fileType || typeof csvText !== 'string') return bad('fileType and csvText are required', 422);

  const rows = parseCsv(csvText);
  if (rows.length === 0) return bad('No data rows found in the uploaded CSV', 422);
  const client = adminClient();

  try {
    if (fileType === 'placeholders') {
      const payload = rows.map((r) => ({
        placeholder: r.placeholder,
        data_type: r.data_type,
        description: toNullable(r.description),
        source: toNullable(r.source),
        availability: toNullable(r.availability),
        display_format: toNullable(r.display_format),
        is_active: toBool(r.is_active, true),
        validation_note: toNullable(r.validation_note),
      }));
      const { error } = await client.from('recommendation_template_placeholders').upsert(payload, { onConflict: 'placeholder' });
      if (error) return bad(error.message);
      return ok({ upserted: payload.length });
    }

    if (fileType === 'calculation_methods') {
      const payload = rows.map((r) => ({
        calculation_method_code: r.calculation_method_code,
        method_name: r.method_name,
        forecast_categories: splitList(r.forecast_categories),
        description: toNullable(r.description),
        calculation_service: toNullable(r.calculation_service),
        required_inputs: splitList(r.required_inputs),
        outputs: splitList(r.outputs),
        rounding_method: toNullable(r.rounding_method),
        supported_scenarios: splitList(r.supported_scenarios),
        is_active: toBool(r.is_active, true),
        version_number: toInt(r.version_number, 1),
        admin_notes: toNullable(r.admin_notes),
      }));
      const { error } = await client.from('recommendation_calculation_methods').upsert(payload, { onConflict: 'calculation_method_code' });
      if (error) return bad(error.message);
      return ok({ upserted: payload.length });
    }

    if (fileType === 'master') {
      const payload = rows.map((r) => {
        const isDataQuality = r.forecast_category === 'data_quality';
        return {
          recommendation_code: r.recommendation_code,
          forecast_category: r.forecast_category,
          sub_category: r.sub_category,
          scenario_name: r.scenario_name,
          scenario_description: toNullable(r.scenario_description),
          variance_result: toNullable(r.variance_result),
          forecast_status: r.forecast_status,
          severity: r.severity,
          action_type: r.action_type,
          action_title_template: r.action_title_template,
          action_content_template: r.action_content_template,
          financial_impact_template: toNullable(r.financial_impact_template),
          calculation_method_code: toNullable(r.calculation_method_code),
          required_input_fields: splitList(r.required_input_fields),
          supported_placeholders: splitList(r.supported_placeholders),
          priority_score: toInt(r.priority_score, 0),
          country_code: toNullable(r.country_code),
          currency_code: toNullable(r.currency_code),
          customer_segment: r.customer_segment || 'base',
          effective_from: toNullable(r.effective_from),
          effective_to: toNullable(r.effective_to),
          is_active: toBool(r.is_active, true),
          requires_ai: toBool(r.requires_ai, false),
          version_number: toInt(r.version_number, 1),
          admin_notes: toNullable(r.admin_notes),
          include_in_forecasting: r.include_in_forecasting !== undefined && r.include_in_forecasting !== '' ? toBool(r.include_in_forecasting) : !isDataQuality,
          include_in_monthly_report: r.include_in_monthly_report !== undefined && r.include_in_monthly_report !== '' ? toBool(r.include_in_monthly_report) : isDataQuality,
        };
      });
      const { error } = await client.from('action_recommendation_master').upsert(payload, { onConflict: 'recommendation_code' });
      if (error) return bad(error.message);
      return ok({ upserted: payload.length });
    }

    if (fileType === 'conditions') {
      const byCode = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byCode.get(r.recommendation_code) ?? [];
        list.push(r);
        byCode.set(r.recommendation_code, list);
      }
      const codes = [...byCode.keys()];
      const { error: deleteError } = await client.from('action_recommendation_conditions').delete().in('recommendation_code', codes);
      if (deleteError) return bad(deleteError.message);

      const payload = rows.map((r) => ({
        recommendation_code: r.recommendation_code,
        condition_group: toInt(r.condition_group, 1),
        field_name: r.field_name,
        operator: r.operator || 'equals',
        comparison_value: toNullable(r.comparison_value),
        comparison_value_2: toNullable(r.comparison_value_2),
        data_type: r.data_type || 'text',
        logical_operator: r.logical_operator || 'AND',
        evaluation_order: toInt(r.evaluation_order, 1),
        is_active: toBool(r.is_active, true),
      }));
      const { error: insertError } = await client.from('action_recommendation_conditions').insert(payload);
      if (insertError) return bad(insertError.message);
      return ok({ codesReplaced: codes.length, conditionsInserted: payload.length });
    }

    return bad(`Unknown fileType "${fileType}"`, 422);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Upload failed');
  }
}
