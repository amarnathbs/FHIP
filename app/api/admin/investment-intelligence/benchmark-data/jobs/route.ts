// Benchmark Data - list import jobs. Capability `view` (read-only). Caller's own session; RLS also
// restricts these tables to the benchmark-data viewer predicate. Another admin's id is never returned.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { listImportJobs } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { guarded, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  try {
    return ok(await listImportJobs(g.supabase, g.user.id, 50));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (isMissingRelation(err)) return Response.json({ error: 'The benchmark import tables are not available in this database (migration 0239 not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(err, 'benchmark import jobs');
  }
});
