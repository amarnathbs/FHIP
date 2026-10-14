// Market Index Data - the audit timeline of one entitlement record, including the records it replaced or was replaced by.
// Capability `view` (read only). The caller's own session reads the append-only governance log under its row-level policy.
// The actor of each line is only "You" or a role, never another administrator (see entitlementHistory.ts); only the
// whitelisted editable fields are compared, so no user id or contract reference beyond the Entitlements screen leaves here.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { buildTimeline, lineageOf, type GovernanceEventRow } from '@/lib/services/investment-intelligence/benchmarkData/entitlementHistory';
import { guarded, idParam, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { EntitlementHistoryResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;

  const rec = await g.supabase.from('ii_benchmark_entitlements').select('id, benchmark_id, supersedes_entitlement_id, superseded_by').eq('id', id.id).maybeSingle();
  if (rec.error) {
    if (isMissingRelation(rec.error)) return Response.json({ error: 'The history is not available yet (migration 0280 is not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(rec.error, 'benchmark entitlement history');
  }
  if (!rec.data) return Response.json({ error: 'Entitlement not found.', code: 'not_found' }, { status: 404 });
  const benchmarkId = (rec.data as { benchmark_id: string }).benchmark_id;

  const siblings = await g.supabase.from('ii_benchmark_entitlements').select('id, supersedes_entitlement_id, superseded_by').eq('benchmark_id', benchmarkId).limit(500);
  if (siblings.error) return safeDbError(siblings.error, 'benchmark entitlement history');
  const lineage = lineageOf((siblings.data ?? []) as Array<{ id: string; supersedes_entitlement_id: string | null; superseded_by: string | null }>, id.id);

  const ev = await g.supabase
    .from('ii_benchmark_governance_events')
    .select('event_type, actor_user_id, actor_kind, before_state, after_state, reason, created_at, subject_id')
    .eq('subject_table', 'ii_benchmark_entitlements')
    .in('subject_id', lineage.ids)
    .order('created_at', { ascending: true })
    .limit(500);
  if (ev.error) return safeDbError(ev.error, 'benchmark entitlement history');

  const body: EntitlementHistoryResponse = {
    entitlementId: id.id,
    entries: buildTimeline((ev.data ?? []) as unknown as GovernanceEventRow[], { callerId: g.user.id, recordId: id.id, earlierIds: lineage.earlier }),
  };
  return ok(body);
});
