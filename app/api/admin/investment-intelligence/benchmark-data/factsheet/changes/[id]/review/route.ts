// Market Index Data - decide a queued factsheet change. Capability `catalogue`.
//
// approve      creates the effective-dated mapping through the EXISTING review path (review_benchmark_mapping, called
//              inside review_factsheet_change); a changed benchmark needs closePrevious so the earlier mapping ends the
//              day before. The database re-checks the capability, the verified catalogue entry and the no-overlap rule.
// reject       declines it; the version stays on record (history is never edited).
// manual       the reviewer entered the mapping by hand instead.
// acknowledge  for a declared benchmark the catalogue cannot represent: nothing is published; the scheme is shown as
//              "declared benchmark, cannot be compared with the data we hold".
import { z } from 'zod';
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, idParam, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

const Body = z.object({ decision: z.enum(['approve', 'reject', 'manual', 'acknowledge']), note: z.string().min(10).max(500), closePrevious: z.boolean().optional() });

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('review_factsheet_change', { p_version: id.id, p_decision: body.data.decision, p_note: body.data.note, p_close_previous: body.data.closePrevious === true });
  if (error) return rpcFailureResponse(error);
  const d = (data ?? {}) as { decision?: string; mapping_id?: string | null };
  return ok({ decision: body.data.decision, mappingId: d.mapping_id ?? null });
});
