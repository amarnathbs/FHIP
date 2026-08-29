import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { validateEditConditions } from '@/lib/services/recommendationEditValidation';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const client = adminClient();

  // A0.2 Wave 1B (D-01-class fix, PATCH path): the master-field update and
  // the conditions replace are now one atomic database transaction
  // (migration 0109's admin_upsert_recommendation_atomic) — never
  // UPDATE-then-DELETE-then-INSERT as three independent requests. See that
  // migration's header for the original defect this closes.
  const { conditions, clearConditions, ...masterFields } = body;

  // `conditions` omitted entirely (undefined) means "leave conditions
  // untouched" (e.g. the plain is_active toggle button sends only
  // {is_active}) — validateEditConditions() returns {ok:true, conditions:
  // undefined} for that case, which the RPC below interprets as "do not
  // touch conditions at all".
  const validated = validateEditConditions(conditions, { clearConditions: Boolean(clearConditions) });
  if (!validated.ok) {
    return Response.json({ error: 'Validation failed — nothing was changed.', data: { status: 'validation_failed', errors: validated.errors } }, { status: 422 });
  }

  const { error: rpcError } = await client.rpc('admin_upsert_recommendation_atomic', {
    p_id: id,
    p_master: masterFields,
    p_conditions: validated.conditions ?? null,
    p_clear_conditions: Boolean(clearConditions),
  });
  if (rpcError) {
    console.error('admin_upsert_recommendation_atomic (update) RPC failed:', rpcError);
    if (rpcError.code === 'P0002') return bad('This recommendation no longer exists.', 404);
    if (rpcError.code === '23514') return bad('This would leave an active recommendation with zero conditions, which matches every user unconditionally. Set "matches unconditionally" explicitly, add a condition, or leave it inactive.', 422);
    return bad('The recommendation could not be updated due to a database error. Nothing was changed.', 500);
  }

  const { data: master, error: fetchError } = await client.from('action_recommendation_master').select('*').eq('id', id).single();
  if (fetchError) return bad('Updated, but could not re-read the record.', 500);
  return ok(master);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const client = adminClient();
  // Soft-delete only — matches already generated against this row keep
  // their history intact (user_recommendation_matches references master.id).
  const { data, error } = await client
    .from('action_recommendation_master')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  return error ? bad(error.message) : ok(data);
}
