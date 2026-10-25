import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { advanceStatementJob } from '@/lib/services/investment-intelligence/statementJob/worker';
import { jobViewResponse, isUnavailable, unavailableResponse } from '@/lib/services/investment-intelligence/statementJob/routeHelpers';
import type { StatementJobRow } from '@/lib/services/investment-intelligence/statementJob/model';

// POST /api/investment-intelligence/statement-jobs/{jobId}/advance -- the browser's poll. It does ONE bounded slice of the job's work
// (well under the platform's 28 s limit) and answers with the job's state. If another tab, or the scheduled backstop, is already working
// on the job this answers at once with `busy` and the current state; asking repeatedly is always safe.
//
// This is a CONTINUATION of work the statement's admission already allowed (the Premium check and the malware scan happened at
// admission): it starts no new admission and no new file. The optional body carries the document password for the slice that opens the
// file; it is used in memory for that one call and never stored, staged, logged or echoed. A job that is not the caller's is a 404,
// exactly like a job that does not exist.
export const maxDuration = 30;

const bodySchema = z.object({ password: z.string().max(256).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return bad('not found', 404);
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  const password = body.success ? body.data.password : undefined;
  // Ownership is established by the caller's own row-level-security read; the worker then runs under the service role.
  const supabase = await createClient();
  const { data: own, error: ownError } = await supabase.from('ii_statement_jobs').select('id').eq('id', jobId).eq('user_id', user.id).maybeSingle();
  if (ownError) return bad('We could not read this job.', 500, 'job_read_failed');
  if (!own) return bad('not found', 404);
  try {
    const out = await advanceStatementJob(jobId, { userId: user.id, password });
    if (out.kind === 'not_found') return bad('not found', 404);
    return jobViewResponse(out.job as StatementJobRow, { advanced: out.kind === 'advanced', busy: out.kind === 'busy' });
  } catch (e) {
    if (isUnavailable(e)) return unavailableResponse();
    console.error('[statement-job/advance] unexpected failure', { jobIdPrefix: jobId.slice(0, 8), name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    return bad('We could not continue this just now. It is saved and will carry on.', 500, 'advance_failed');
  }
}
