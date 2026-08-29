import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { validateEditConditions } from '@/lib/services/recommendationEditValidation';

type AdminClient = ReturnType<typeof adminClient>;

// A0.2 Wave 1B live-DEV finding (discovered during the manual Admin UI
// verification pass, not part of the original D-01 scope, but directly
// endangers this wave's own atomicity guarantee — see below): Supabase/
// PostgREST caps a plain `.select()` at 1000 rows. With 2150+ real condition
// rows, the previous unpaginated fetch here silently returned only the
// first 1000 — the exact same danger class lib/services/recommendationsData.ts's
// fetchAllMasterRows()/fetchAllConditionRows() already guard against for the
// end-user-facing matching engine, just never applied to this Admin route.
// Reproduced live against real DEV: XBR_INCOME_GOAL_CURRENCY_MISMATCH_CRT
// genuinely has 4 conditions in the database, but the unpaginated fetch
// never reached its rows (they fall past row 1000), so the Admin UI showed
// "0 condition(s)" for it.
// This is not merely a display bug: startEdit() populates the edit form's
// `conditions` array directly from this GET response, and submitForm()
// ALWAYS sends that array back on save (even a save that only touches an
// unrelated field). Under Wave 1B's atomic admin_upsert_recommendation_atomic
// RPC, that save would faithfully — and atomically — REPLACE the real 4
// conditions with the incomplete/empty set the truncated GET request
// supplied. The transactional fix makes a bad write commit-or-rollback
// cleanly; it cannot protect against a "successful" write built on
// incomplete input. Paginating this fetch is what actually closes that gap.
const PAGE_SIZE = 1000;

async function fetchAllMasterRows(client: AdminClient): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('action_recommendation_master')
      .select('*')
      .order('forecast_category')
      .order('priority_score', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

async function fetchAllConditionRows(client: AdminClient): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from('action_recommendation_conditions').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const client = adminClient();
  let masterRows: Record<string, unknown>[];
  let conditionRows: Record<string, unknown>[];
  try {
    [masterRows, conditionRows] = await Promise.all([fetchAllMasterRows(client), fetchAllConditionRows(client)]);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load recommendations');
  }

  const conditionsByCode = new Map<string, unknown[]>();
  for (const row of conditionRows) {
    const code = row.recommendation_code as string;
    const list = conditionsByCode.get(code) ?? [];
    list.push(row);
    conditionsByCode.set(code, list);
  }
  const data = masterRows.map((row) => ({ ...row, conditions: conditionsByCode.get(row.recommendation_code as string) ?? [] }));
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
