import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { validateEditConditions } from '@/lib/services/recommendationEditValidation';

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
  // A0.2 Wave 1B: create + its conditions are now one atomic database
  // transaction (migration 0109's admin_upsert_recommendation_atomic),
  // never two independent requests — see that migration's header for why
  // the original INSERT-master-then-INSERT-conditions pattern was unsafe
  // (identical defect class to Wave 1's D-01).
  const client = adminClient();
  const { conditions, clearConditions, ...masterFields } = body;

  const validated = validateEditConditions(conditions, { clearConditions: Boolean(clearConditions) });
  if (!validated.ok) {
    return Response.json({ error: 'Validation failed — nothing was created.', data: { status: 'validation_failed', errors: validated.errors } }, { status: 422 });
  }

  const { data: rpcData, error: rpcError } = await client.rpc('admin_upsert_recommendation_atomic', {
    p_id: null,
    p_master: masterFields,
    p_conditions: validated.conditions ?? null,
    p_clear_conditions: Boolean(clearConditions),
  });
  if (rpcError) {
    console.error('admin_upsert_recommendation_atomic (create) RPC failed:', rpcError);
    // A duplicate recommendation_code or the active+zero-conditions
    // invariant are the two realistic causes an Admin can self-correct —
    // surface those distinctly; everything else stays generic (no raw DB
    // internals to the client).
    if (rpcError.code === '23505') return bad(`recommendation_code "${masterFields.recommendation_code}" already exists.`, 409);
    if (rpcError.code === '23514') return bad('This would leave an active recommendation with zero conditions, which matches every user unconditionally. Set "matches unconditionally" explicitly, add a condition, or leave it inactive.', 422);
    return bad('The recommendation could not be created due to a database error. Nothing was created.', 500);
  }

  const { data: master, error: fetchError } = await client.from('action_recommendation_master').select('*').eq('id', (rpcData as { id: string }).id).single();
  if (fetchError) return bad('Created, but could not re-read the record.', 500);
  return ok(master);
}
