// Planning Benchmarks - staged upload: preview of one batch with the diff against live values (GET).
// Capability `view` (upload OR activate). The database function checks the capability again. Caller's
// session client only. See app/api/admin/benchmarks/upload/route.ts for the Standard applicability.
import { adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { guarded, idParam, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { getPlanningBenchmarkUpload } from '@/lib/planning-benchmarks/uploadService';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const p = await idParam(params);
  if (!p.ok) return p.response;
  return failClosed(
    () => getPlanningBenchmarkUpload(g.supabase, p.id),
    (data) => ok({ ...data, capabilities: { upload: g.flags.upload, activate: g.flags.activate } })
  );
});
