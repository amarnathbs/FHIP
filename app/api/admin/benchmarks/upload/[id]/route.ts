// Planning Benchmarks - staged upload: preview of one batch with the diff against live values (GET).
// Capability `view` (upload OR activate). The database function checks the capability again. Caller's
// session client only. See app/api/admin/benchmarks/upload/route.ts for the Standard applicability.
import { adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { guarded, idParam, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { getPlanningBenchmarkUpload } from '@/lib/planning-benchmarks/uploadService';
import { loadMappingStatus } from '@/lib/planning-benchmarks/allowedValues';
import { addFigureContext } from '@/lib/planning-benchmarks/previewFigures';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const p = await idParam(params);
  if (!p.ok) return p.response;
  // The preview shows a visible warning when the dataset to metric mapping is not installed (migration 0277): the
  // staged rows were then not checked against it. 'unavailable' is shown as such, never as 'installed'.
  // addFigureContext adds the currency and unit of each figure so the screen formats each by its own currency.
  const mapping = await loadMappingStatus(g.supabase);
  return failClosed(
    async () => addFigureContext(g.supabase, await getPlanningBenchmarkUpload(g.supabase, p.id)),
    (data) => ok({ ...data, capabilities: { upload: g.flags.upload, activate: g.flags.activate }, mapping })
  );
});
