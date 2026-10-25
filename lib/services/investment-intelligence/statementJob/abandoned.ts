/**
 * Document2 (4) WP-J -- jobs nobody came back to.
 *
 * A job whose page was closed and which the scheduled backstop cannot finish (for example a protected statement that needs its password, or
 * no schedule is registered) would otherwise stay queued for ever and keep its staged statement data. After STATEMENT_JOB_ABANDONED_AFTER_MS
 * without any activity and without a live lease it is ended honestly as failed ("abandoned"), its parse run is closed as failed (never
 * succeeded), and its temporary staging is removed. Nothing the job already wrote is touched (every write is re-derivable on the next attempt).
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { deleteChunks, transitionJob } from './store';
import { STATEMENT_JOB_ABANDONED_AFTER_MS, type StatementJobRow } from './model';

export const ABANDONED_JOB_MESSAGE = 'This statement was not finished and nobody came back to it, so processing was stopped. Nothing was lost. Process it again when you are ready.';

export async function abandonIdleStatementJobs(nowMs: number = Date.now(), limit = 50): Promise<number> {
  const admin = createAdminClient();
  const cutoff = new Date(nowMs - STATEMENT_JOB_ABANDONED_AFTER_MS).toISOString();
  const { data, error } = await admin
    .from('ii_statement_jobs')
    .select('*')
    .in('status', ['queued', 'processing'])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) return 0;
  let ended = 0;
  for (const job of (data ?? []) as StatementJobRow[]) {
    if (job.lease_expires_at && Date.parse(job.lease_expires_at) > nowMs) continue; // somebody holds a live lease
    const result = await transitionJob(job.id, { status: job.status }, {
      status: 'failed',
      lease_owner: null,
      lease_expires_at: null,
      error_code: 'abandoned',
      error_message_sanitised: ABANDONED_JOB_MESSAGE,
      result_summary: { ok: false, status: 'abandoned', parseRunId: null, error: ABANDONED_JOB_MESSAGE },
      completed_at: new Date(nowMs).toISOString(),
    });
    if (!transitionedTo(result)) continue;
    await admin
      .from('ii_document_parse_runs')
      .update({ run_status: 'failed', completed_at: new Date(nowMs).toISOString(), errors: [{ code: 'run_abandoned', message: ABANDONED_JOB_MESSAGE, severity: 'error' }] })
      .like('idempotency_key', `job:${job.id}:%`)
      .in('run_status', ['queued', 'running']);
    await deleteChunks(job.id, job.user_id);
    ended += 1;
  }
  return ended;
}

const transitionedTo = (row: StatementJobRow | null): row is StatementJobRow => row !== null;
