// Market Index Data - revoke an entitlement (reason >= 10 characters). Capability `entitlementApprove`.
// Revocation takes effect immediately for readers (the series RLS gate) and blocks any staged job.
import { z } from 'zod';
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('entitlementApprove');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, z.object({ reason: z.string().min(10).max(500) }));
  if (!body.ok) return body.response;
  const { error } = await g.supabase.rpc('revoke_benchmark_entitlement', { p_id: id.id, p_reason: body.data.reason });
  if (error) return rpcFailureResponse(error);
  return ok({ revoked: true });
});
