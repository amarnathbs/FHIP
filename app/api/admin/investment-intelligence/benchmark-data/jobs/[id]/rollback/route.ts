// Market Index Data - roll a published import back (restore previous levels / retract inserted rows;
// history is preserved as revisions). Capability `correct`; reason >= 20 characters; audited in
// ii_benchmark_governance_events and ii_reference_corrections by the RPC.
import { z } from 'zod';
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { rollbackBenchmarkImport } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { guarded, idParam, parseBody } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('correct');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, z.object({ reason: z.string().min(20).max(1000) }));
  if (!body.ok) return body.response;
  const outcome = await rollbackBenchmarkImport(g.supabase, id.id, body.data.reason);
  if (outcome.status === 'failed') return Response.json({ error: outcome.message, code: outcome.kind }, { status: outcome.httpStatus });
  return ok(outcome);
});
