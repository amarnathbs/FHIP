// Benchmark Data - review a mapping proposal (approve creates the canonical effective-dated mapping
// transactionally with audit; reject records the decision). Capability `catalogue`.
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
  const body = await parseBody(req, z.object({ decision: z.enum(['approve', 'reject']), note: z.string().min(10).max(500), closePrevious: z.boolean().optional() }));
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('review_benchmark_mapping', { p_proposal: id.id, p_decision: body.data.decision, p_note: body.data.note, p_close_previous: body.data.closePrevious === true });
  if (error) return rpcFailureResponse(error);
  return ok({ decision: body.data.decision, mappingId: (data as string | null) ?? null });
});
