import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();
  const [master, conditions] = await Promise.all([
    client.from('action_recommendation_master').select('*').order('forecast_category').order('priority_score', { ascending: false }),
    client.from('action_recommendation_conditions').select('*'),
  ]);
  if (master.error) return bad(master.error.message);
  if (conditions.error) return bad(conditions.error.message);

  const conditionsByCode = new Map<string, unknown[]>();
  for (const row of conditions.data ?? []) {
    const list = conditionsByCode.get(row.recommendation_code) ?? [];
    list.push(row);
    conditionsByCode.set(row.recommendation_code, list);
  }
  const data = (master.data ?? []).map((row) => ({ ...row, conditions: conditionsByCode.get(row.recommendation_code) ?? [] }));
  return ok(data);
}

export async function POST(req: Request) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  const required = ['recommendation_code', 'sub_category', 'scenario_name', 'severity', 'action_type', 'action_title_template', 'action_content_template'];
  for (const field of required) {
    if (!body[field]) return bad(`${field} is required`, 422);
  }
  // trigger_type-conditional fields — mirrors migration 0025's
  // action_recommendation_master_trigger_fields_check (forecast_category +
  // forecast_status for the original forecast-triggered rows; pillar_code +
  // score_band for Phase 3a's Health Score-triggered rows).
  const triggerType = body.trigger_type ?? 'forecast_variance';
  if (triggerType === 'forecast_variance') {
    if (!body.forecast_category) return bad('forecast_category is required', 422);
    if (!body.forecast_status) return bad('forecast_status is required', 422);
  } else if (triggerType === 'score_pillar') {
    if (!body.pillar_code) return bad('pillar_code is required', 422);
    if (!body.score_band) return bad('score_band is required', 422);
  } else {
    return bad('trigger_type must be forecast_variance or score_pillar', 422);
  }
  const client = adminClient();
  const { conditions, ...masterFields } = body;
  const { data: master, error: masterError } = await client
    .from('action_recommendation_master')
    .insert({ ...masterFields, is_active: masterFields.is_active ?? false })
    .select('*')
    .single();
  if (masterError) return bad(masterError.message);

  if (Array.isArray(conditions) && conditions.length > 0) {
    const { error: conditionsError } = await client.from('action_recommendation_conditions').insert(
      conditions.map(
        (c: { condition_group?: number; field_name: string; operator?: string; comparison_value?: string | null; evaluation_order?: number }) => ({
          recommendation_code: master.recommendation_code,
          condition_group: c.condition_group ?? 1,
          field_name: c.field_name,
          operator: c.operator ?? 'equals',
          comparison_value: c.comparison_value ?? null,
          evaluation_order: c.evaluation_order ?? 1,
        })
      )
    );
    if (conditionsError) return bad(conditionsError.message);
  }

  return ok(master);
}
