import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { toBankImportJobView, type BankImportJobRow } from '@/lib/financial-data-hub/bankImport/jobModel';

// GET /api/financial-data-hub/bank-import-jobs -- the signed-in user's UNFINISHED bank statement imports (queued, running, or waiting
// for the person). A page that was reloaded or reopened asks this to pick its imports up again; nothing restarts and no line is
// written twice. READ ONLY, through the caller's own row-level-security client (a job of another user can never appear here), and
// filtered by user_id as well. Before migration 0310 is applied the list is simply empty.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_bank_import_jobs')
    .select('*')
    .eq('user_id', user.id)
    .in('status', ['queued', 'processing', 'review_required'])
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return ok({ jobs: [] });
  const jobs = ((data ?? []) as BankImportJobRow[]).map((j) => toBankImportJobView(j));
  return Response.json({ data: { jobs } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
