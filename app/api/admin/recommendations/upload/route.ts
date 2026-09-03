import { requireAdmin, adminClient, safeDbError } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { parseCsv, splitList } from '@/lib/utils/csv';
import { validateConditionsImport, buildImportPayload, MAX_CSV_BYTES } from '@/lib/services/recommendationsConditionsImport';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';

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
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const fileType = body.fileType as FileType;
  const csvText = body.csvText as string;
  if (!fileType || typeof csvText !== 'string') return bad('fileType and csvText are required', 422);

  // The conditions path has its own, stricter size gate ahead of parsing
  // (spec 5.1 "maximum safe row/file limits") — kept scoped to this one
  // fileType so master/calculation_methods/placeholders uploads are not
  // materially changed by this wave.
  if (fileType === 'conditions' && Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    return bad(`The uploaded file is too large (max ${Math.floor(MAX_CSV_BYTES / (1024 * 1024))}MB for conditions uploads).`, 413);
  }

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
      if (error) return safeDbError(error, 'Recommendation placeholders upload');
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
      if (error) return safeDbError(error, 'Recommendation calculation-methods upload');
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
      if (error) return safeDbError(error, 'Recommendation master upload');
      return ok({ upserted: payload.length });
    }

    if (fileType === 'conditions') {
      // D-01 fix (A0.2 Wave 1): pre-validate the WHOLE file, then apply it
      // as one atomic database transaction (migration 0107's
      // admin_import_recommendation_conditions RPC) — never delete-then-
      // insert as two independent requests. See
      // lib/services/recommendationsConditionsImport.ts for the full
      // validation contract and canonical replacement semantics.
      const codesInFile = [...new Set(rows.map((r) => (r.recommendation_code ?? '').trim()).filter((c) => c !== ''))];
      const { data: existingRows, error: existingError } = await client
        .from('action_recommendation_master')
        .select('recommendation_code')
        .in('recommendation_code', codesInFile.length > 0 ? codesInFile : ['__none__']);
      if (existingError) return bad('Could not verify recommendation codes. No changes were made.', 500);
      const existingCodes = new Set((existingRows ?? []).map((r) => r.recommendation_code as string));

      const validated = validateConditionsImport(rows, existingCodes);
      if (!validated.ok) {
        return Response.json(
          {
            error: 'Validation failed — no existing conditions were changed.',
            data: {
              importType: 'conditions',
              status: 'validation_failed',
              rowsReceived: validated.rowsReceived,
              rowsValidated: validated.rowsValidated,
              recommendationsAffected: 0,
              conditionsInserted: 0,
              conditionsReplaced: 0,
              errors: validated.errors,
            },
          },
          { status: 422 }
        );
      }

      if (validated.groups.length === 0) {
        // Every row was blank/no-op after validation (should be unreachable
        // given the empty-file guard above, but stays a safe zero-mutation
        // no-op rather than an error if it is ever reached).
        return ok({
          importType: 'conditions',
          status: 'success',
          rowsReceived: validated.rowsReceived,
          rowsValidated: validated.rowsValidated,
          recommendationsAffected: 0,
          conditionsInserted: 0,
          conditionsReplaced: 0,
          codes: [],
        });
      }

      const { data: rpcData, error: rpcError } = await client.rpc('admin_import_recommendation_conditions', {
        p_import: buildImportPayload(validated.groups),
      });
      if (rpcError) {
        // Never forward raw database internals to the client (spec 5.1/5.3).
        console.error('admin_import_recommendation_conditions RPC failed:', rpcError);
        return bad('The import could not be completed due to a database error. No existing conditions were changed.', 500);
      }

      const outcome = rpcData as { recommendationsAffected: number; conditionsInserted: number; conditionsReplaced: number; codes: string[] };

      // Best-effort audit record (spec section 9) — never fails the
      // already-committed mutation. No raw CSV content is stored, only a
      // safe summary.
      if (user) {
        await logResourceAudit(client, {
          entity_type: 'recommendation_conditions_import',
          entity_id: null,
          action: 'conditions_csv_import',
          actor_user_id: user.id,
          metadata: {
            rowsReceived: validated.rowsReceived,
            rowsValidated: validated.rowsValidated,
            recommendationsAffected: outcome.recommendationsAffected,
            conditionsInserted: outcome.conditionsInserted,
            conditionsReplaced: outcome.conditionsReplaced,
            recommendationCodes: outcome.codes,
          },
        });
      }

      return ok({
        importType: 'conditions',
        status: 'success',
        rowsReceived: validated.rowsReceived,
        rowsValidated: validated.rowsValidated,
        recommendationsAffected: outcome.recommendationsAffected,
        conditionsInserted: outcome.conditionsInserted,
        conditionsReplaced: outcome.conditionsReplaced,
        codes: outcome.codes,
      });
    }

    return bad(`Unknown fileType "${fileType}"`, 422);
  } catch (e) {
    // Gate G6 (found beyond the originally-named 19 call sites, same
    // class): an unexpected exception here (e.g. a CSV-parsing edge case)
    // must not surface its raw message either.
    console.error('Recommendation upload — unexpected error:', e);
    return bad('Upload failed. Please check the file and try again.', 500);
  }
}
