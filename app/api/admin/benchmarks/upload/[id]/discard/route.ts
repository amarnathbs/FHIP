// Planning Benchmarks - staged upload: DISCARD a staged batch (POST). Nothing was ever live, so nothing is removed
// from live data. Capability `view` at the API layer (upload OR activate); the database function then enforces
// the finer rule: an uploader may discard only a batch they staged, an activator any batch. Caller's session
// client only. See upload/route.ts for the Standard applicability.
import { z } from 'zod';
import { adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { guarded, idParam, parseBody, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { discardPlanningBenchmarkUpload } from '@/lib/planning-benchmarks/uploadService';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().max(500).nullish() });

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const p = await idParam(params);
  if (!p.ok) return p.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  return failClosed(
    () => discardPlanningBenchmarkUpload(g.supabase, p.id, body.data.reason ?? null),
    (data) => ok(data)
  );
});
