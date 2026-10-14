// Planning Benchmarks - staged upload: ACTIVATE a staged batch (POST). Makes the rows live for the Financial Twin.
//
// Capability `activate` (admin_users.can_activate_planning_benchmarks), SEPARATE from `upload`: a holder of
// only the upload capability receives 403 here, and the database function refuses them too. The request is
// bound to what the reviewer saw (file hash, staging digest, previewed counts) and to an explicit
// `confirmed: true`. Runs under the caller's session client. See upload/route.ts for the Standard applicability.
import { z } from 'zod';
import { adminRoute } from '@/lib/services/adminAuth';
import { ok } from '@/lib/api';
import { guarded, idParam, parseBody, failClosed } from '@/lib/planning-benchmarks/routeSupport';
import { activatePlanningBenchmarkUpload } from '@/lib/planning-benchmarks/uploadService';

export const dynamic = 'force-dynamic';

const Body = z.object({
  confirmed: z.literal(true),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expectedCounts: z.record(z.string().max(20), z.number().int().min(0)),
  selfActivationAck: z.boolean().optional(),
});

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('activate');
  if (!g.ok) return g.response;
  const p = await idParam(params);
  if (!p.ok) return p.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  return failClosed(
    () =>
      activatePlanningBenchmarkUpload(g.supabase, p.id, {
        expectedSha256: body.data.expectedSha256,
        expectedDigest: body.data.expectedDigest,
        expectedCounts: body.data.expectedCounts,
        selfActivationAck: body.data.selfActivationAck === true,
      }),
    (data) => ok(data)
  );
});
