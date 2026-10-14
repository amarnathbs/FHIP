// Market Index Data - edit a DRAFT entitlement (or an open revision) in place. Capability `catalogue`
// (can_manage_benchmark_catalogue, the capability that proposes). The database lets only the person who
// proposed the draft change it, refuses a save that changes nothing or comes from a stale screen
// (expectedEditCount), and writes every save to the audit trail with the fields before and after.
// An APPROVED record is never edited in place: it is revised (see ../revise).
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { EntitlementEditBody, guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, EntitlementEditBody);
  if (!body.ok) return body.response;
  const { expectedEditCount, ...p } = body.data;
  const { data, error } = await g.supabase.rpc('update_benchmark_entitlement_draft', { p_id: id.id, p, p_expected_edit_count: expectedEditCount });
  if (error) return rpcFailureResponse(error);
  return ok({ edited: true, editCount: data as number });
});
