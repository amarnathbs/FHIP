// Market Index Data - entitlement records (what FHIP may DO with a benchmark series, right by right).
// GET: capability `view`. POST (propose a DRAFT): capability `catalogue`. Approval/revocation are a
// separate capability (`entitlementApprove`) on separate routes: a proposer cannot approve without an
// explicit, recorded self-approval acknowledgement.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { EntitlementBody, guarded, isMissingRelation, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { EntitlementRightsView } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { mapEntitlementRow, readEntitlements } from '@/lib/services/investment-intelligence/benchmarkData/entitlementView';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error, editSupported } = await readEntitlements<Array<Record<string, unknown>>>(
    (cols) =>
      g.supabase.from('ii_benchmark_entitlements').select(cols).order('created_at', { ascending: false }).limit(500) as unknown as PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { code?: string; message?: string } | null }>,
    ', ii_benchmarks(benchmark_key)'
  );
  if (error) {
    if (isMissingRelation(error)) return Response.json({ error: 'Entitlement tables are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(error, 'benchmark entitlements');
  }
  const byBenchmark: Record<string, EntitlementRightsView[]> = {};
  for (const r of data ?? []) {
    const key = ((r.ii_benchmarks as { benchmark_key: string } | null)?.benchmark_key) ?? String(r.benchmark_id);
    (byBenchmark[key] ??= []).push(mapEntitlementRow(r, g.user.id, editSupported));
  }
  return ok(byBenchmark);
});

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const body = await parseBody(req, EntitlementBody);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('propose_benchmark_entitlement', { p: body.data });
  if (error) return rpcFailureResponse(error);
  return ok({ id: data as string, status: 'draft' });
});
