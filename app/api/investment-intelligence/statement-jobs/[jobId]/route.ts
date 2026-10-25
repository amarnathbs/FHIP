import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { jobViewResponse } from '@/lib/services/investment-intelligence/statementJob/routeHelpers';
import type { StatementJobRow } from '@/lib/services/investment-intelligence/statementJob/model';

// GET /api/investment-intelligence/statement-jobs/{jobId} -- the state of one statement job (status, step, progress, and the finished
// answer). READ ONLY and idempotent. A job that is not the caller's is indistinguishable from one that does not exist (404): the read
// goes through the caller's own row-level-security client.
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return bad('not found', 404);
  const supabase = await createClient();
  const { data, error } = await supabase.from('ii_statement_jobs').select('*').eq('id', jobId).eq('user_id', user.id).maybeSingle();
  if (error) return bad('We could not read this job.', 500, 'job_read_failed');
  if (!data) return bad('not found', 404);
  return jobViewResponse(data as StatementJobRow);
}
