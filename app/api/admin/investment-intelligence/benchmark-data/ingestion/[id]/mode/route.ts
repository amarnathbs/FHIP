// Benchmark Data - set a benchmark's ingestion mode (disabled / manual_import / automated).
// Capability `catalogue`. Enabling automation additionally needs an approved 'automation' entitlement
// (the RPC refuses otherwise), and a run still needs the environment flag, the global and write
// kill switches. Setting a mode grants nothing by itself.
import { z } from 'zod';
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(
    req,
    z.object({
      mode: z.enum(['disabled', 'manual_import', 'automated']),
      sourceKey: z.string().max(100).nullish(),
      adapterId: z.string().max(100).nullish(),
      automationEnabled: z.boolean(),
      publicationLagDays: z.number().int().min(0).max(30).optional(),
      reason: z.string().min(10).max(500),
    })
  );
  if (!body.ok) return body.response;
  const b = body.data;
  const { error } = await g.supabase.rpc('set_benchmark_ingestion_mode', { p_benchmark: id.id, p_mode: b.mode, p_source_key: b.sourceKey ?? null, p_adapter: b.adapterId ?? null, p_automation_enabled: b.automationEnabled, p_lag_days: b.publicationLagDays ?? 1, p_reason: b.reason });
  if (error) return rpcFailureResponse(error);
  return ok({ mode: b.mode, automationEnabled: b.automationEnabled });
});
