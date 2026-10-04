// Market Index Data - set the terms-review status of a registered fund-house document. Capability `entitlementApprove`
// (the existing "may we use this source" capability; a catalogue admin or a view-only admin cannot). The database function
// set_factsheet_source_terms_status re-checks the capability, requires a note of at least 10 characters, records the
// reviewer and the time, and writes the governance log. Until a source is 'approved' the factsheet reader REFUSES to
// fetch from it. If migration 0252 is not applied the answer is an explicit 503.
import { z } from 'zod';
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, idParam, isMissingRelation, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

const Body = z.object({ status: z.enum(['approved', 'not_reviewed', 'declined']), note: z.string().trim().min(10).max(500) });

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('entitlementApprove');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { error } = await g.supabase.rpc('set_factsheet_source_terms_status', { p_source: id.id, p_status: body.data.status, p_note: body.data.note });
  if (error) {
    if (isMissingRelation(error)) return Response.json({ error: 'Source terms cannot be recorded yet: the factsheet reader database update has not been applied.', code: 'unavailable' }, { status: 503 });
    return rpcFailureResponse(error);
  }
  return ok({ id: id.id, status: body.data.status });
});
