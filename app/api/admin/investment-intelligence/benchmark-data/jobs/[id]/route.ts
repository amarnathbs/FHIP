// Market Index Data - one import job (counts, preview, validation issues). Capability `view`.
import { bad, ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { getImportJob } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { guarded, idParam } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  try {
    const detail = await getImportJob(g.supabase, g.user.id, id.id);
    return detail ? ok(detail) : bad('Import job not found', 404);
  } catch (e) {
    return safeDbError(e as { code?: string; message?: string }, 'benchmark import job');
  }
});
