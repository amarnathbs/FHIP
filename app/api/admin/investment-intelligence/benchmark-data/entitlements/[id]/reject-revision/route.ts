// Market Index Data - an approver rejects an open revision. Capability `entitlementApprove`. The original is untouched.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { RevisionCloseBody, guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('entitlementApprove');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, RevisionCloseBody);
  if (!body.ok) return body.response;
  const { error } = await g.supabase.rpc('close_benchmark_entitlement_revision', { p_id: id.id, p_mode: 'reject', p_reason: body.data.reason });
  if (error) return rpcFailureResponse(error);
  return ok({ rejected: true });
});
