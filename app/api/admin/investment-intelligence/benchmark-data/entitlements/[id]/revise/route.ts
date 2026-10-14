// Market Index Data - propose ONE revision of an APPROVED entitlement. Capability `catalogue`.
// The original keeps granting exactly as before until the revision is approved (capability
// `entitlementApprove`, route ../approve); there is no gap and no duplicate approved record. A reason of
// at least 10 characters is required. The database allows at most one open revision per record.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { EntitlementReviseBody, guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, EntitlementReviseBody);
  if (!body.ok) return body.response;
  const { reason, ...p } = body.data;
  const { data, error } = await g.supabase.rpc('propose_benchmark_entitlement_revision', { p_original: id.id, p, p_reason: reason });
  if (error) return rpcFailureResponse(error);
  return ok({ id: data as string, status: 'draft', revisionOf: id.id });
});
