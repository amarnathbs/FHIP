// Market Index Data - HELD schemes and whether they have a benchmark. Capability `view` (read-only).
// The held population is cross-user, so it comes from the aggregate-only SECURITY DEFINER RPC
// benchmark_held_schemes() (migration 0251), which checks the view capability again inside the
// database and returns holder COUNTS only: no user, account, unit or amount ever reaches this route.
// If the migration is not applied the answer is an explicit 503, never an empty list.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { buildHeldSchemeRows, heldRawFromRpc } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.rpc('benchmark_held_schemes');
  if (error) {
    if (isMissingRelation(error)) {
      return Response.json({ error: 'This list needs a database update that has not been applied yet.', code: 'unavailable' }, { status: 503 });
    }
    return rpcFailureResponse(error);
  }
  return ok(buildHeldSchemeRows(heldRawFromRpc(data)));
});
