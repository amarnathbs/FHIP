// Market Index Data - verify a catalogue entry (draft -> verified, with a note). Capability `catalogue`.
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
  const body = await parseBody(req, z.object({ note: z.string().min(10).max(500) }));
  if (!body.ok) return body.response;
  const { error } = await g.supabase.rpc('verify_benchmark_catalogue_entry', { p_id: id.id, p_note: body.data.note });
  if (error) return rpcFailureResponse(error);
  return ok({ verified: true });
});
