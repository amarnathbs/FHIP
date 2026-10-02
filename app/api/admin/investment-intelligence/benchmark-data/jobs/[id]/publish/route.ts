// Market Index Data - approve + publish a validated job.
//
// SEPARATE CAPABILITIES (Standard sections 2 and 5): new history needs `publish`
// (can_publish_benchmark_data); a CORRECTION needs `correct` (can_correct_benchmark_data).
// Neither implies the other. The route learns the job's mode with a read-only view check, then
// requires the matching capability; the database (publish_benchmark_import) enforces it again
// with auth.uid(), re-validates the entitlement, the checksum, the staging digest, the previewed
// counts and the current series, and writes atomically. Caller's own session only.
import { bad, ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { publishBenchmarkImport } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { guarded, idParam, parseBody, PublishBody } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { requireBenchmarkCapability } from '@/lib/services/investment-intelligence/benchmarkData/guards';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const v = await guarded('view');
  if (!v.ok) return v.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  const body = await parseBody(req, PublishBody);
  if (!body.ok) return body.response;

  const { data: job, error } = await v.supabase.from('ii_benchmark_import_jobs').select('mode').eq('id', id.id).maybeSingle();
  if (error) return bad('The import job could not be read.', 503);
  if (!job) return bad('Import job not found', 404);
  const cap = (job as { mode: string }).mode === 'correction' ? 'correct' : 'publish';
  const need = await requireBenchmarkCapability(cap);
  if (need.forbidden) return need.forbidden;

  const outcome = await publishBenchmarkImport(v.supabase, { jobId: id.id, ...body.data, acknowledged: body.data.acknowledged ?? [] });
  if (outcome.status === 'failed') return Response.json({ error: outcome.message, code: outcome.kind }, { status: outcome.httpStatus });
  return ok({ alreadyPublished: outcome.alreadyPublished, result: outcome.result });
});
