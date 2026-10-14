// Market Index Data - approve a DRAFT entitlement, or a REVISION of an approved one (which, in the same database
// transaction, closes the original as superseded). expectedEditCount is the counter the approver saw: if the
// proposer edited the record after it was opened, the database refuses and the approver reviews it again.
// Capability `entitlementApprove`
// (can_approve_benchmark_entitlements). The database refuses a proposer approving their own record
// unless selfApprovalAck is explicit (recorded as self_approved).
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
  const body = await parseBody(req, z.object({ note: z.string().min(5).max(500), selfApprovalAck: z.boolean().optional(), expectedEditCount: z.number().int().min(0).optional() }));
  if (!body.ok) return body.response;
  // The 4th argument exists only once migration 0280 is applied. It is sent only when the screen has one (the screen has one only
  // when the database reported the edit columns), so this route also works against a database that still has the 0241 function.
  const args: Record<string, unknown> = { p_id: id.id, p_note: body.data.note, p_self_approval_ack: body.data.selfApprovalAck === true };
  if (body.data.expectedEditCount !== undefined) args.p_expected_edit_count = body.data.expectedEditCount;
  const { error } = await g.supabase.rpc('approve_benchmark_entitlement', args);
  if (error) return rpcFailureResponse(error);
  return ok({ approved: true });
});
