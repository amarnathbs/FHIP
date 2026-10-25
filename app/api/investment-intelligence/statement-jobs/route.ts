import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { toStatementJobView, type StatementJobRow } from '@/lib/services/investment-intelligence/statementJob/model';

// GET /api/investment-intelligence/statement-jobs -- the signed-in user's UNFINISHED statement jobs (queued, running, or waiting for the
// person), the newest per statement. A page that was reloaded or reopened asks this to pick its work up again; nothing restarts and no
// row is written twice. READ ONLY, through the caller's own row-level-security client (a job of another user can never appear here), and
// filtered by user_id as well. Before migration 0313 is applied the list is simply empty.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_statement_jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) return ok({ jobs: [] });
  // Newest job per statement; of those only the ones still unfinished (a statement whose latest job ended has nothing to resume).
  const latest = new Map<string, StatementJobRow>();
  for (const j of (data ?? []) as StatementJobRow[]) if (!latest.has(j.source_document_id)) latest.set(j.source_document_id, j);
  const jobs = [...latest.values()].filter((j) => j.status === 'queued' || j.status === 'processing' || j.status === 'review_required').map((j) => toStatementJobView(j));
  return Response.json({ data: { jobs } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
