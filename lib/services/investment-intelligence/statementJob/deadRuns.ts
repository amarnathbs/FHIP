/**
 * Document2 (4) WP-J -- dead parse runs.
 *
 * THE PROBLEM. A processing run is recorded as `running` and only ever closed by the code that ends it. When the platform killed the
 * request mid-run (a large statement cannot finish inside 28 seconds) nobody closed it, and every later attempt within 10 minutes was
 * answered "This document is already being processed", while a run that stayed `running` for days looked like work in progress.
 *
 * THE RULE. A run is ALIVE only if something is demonstrably working on it:
 *   - it belongs to a statement job that is still queued or processing (its idempotency key is `job:<jobId>:<attempt>`), or
 *   - it has no job at all (the old synchronous path) and started less than JOBLESS_RUN_DEAD_AFTER_MS ago: that path cannot outlive the
 *     platform's request limit by much.
 * Anything else is DEAD. A dead run is closed as `failed` with an honest reason; it is NEVER marked succeeded, and nothing it wrote is
 * undone (every write of a run is individually idempotent and re-derivable on the next attempt).
 */

import type { createAdminClient } from '@/lib/supabase/admin';
import { JOBLESS_RUN_DEAD_AFTER_MS } from './model';

type Admin = ReturnType<typeof createAdminClient>;

export const DEAD_RUN_MESSAGE =
  'The earlier processing attempt stopped without finishing and showed no sign of progress, so it was closed as failed. Nothing from it was counted as processed. The statement can be processed again.';

interface RunRow {
  id: string;
  started_at: string;
  idempotency_key: string | null;
}

function runIsAlive(run: RunRow, liveJobIds: ReadonlySet<string>, nowMs: number): boolean {
  const key = run.idempotency_key ?? '';
  const m = /^job:([0-9a-f-]{36}):/i.exec(key);
  if (m) return liveJobIds.has(m[1].toLowerCase());
  const startedAt = Date.parse(run.started_at);
  return Number.isFinite(startedAt) && nowMs - startedAt < JOBLESS_RUN_DEAD_AFTER_MS;
}

async function closeRun(admin: Admin, runId: string, nowMs: number): Promise<void> {
  await admin
    .from('ii_document_parse_runs')
    .update({
      run_status: 'failed',
      completed_at: new Date(nowMs).toISOString(),
      errors: [{ code: 'run_abandoned', message: DEAD_RUN_MESSAGE, severity: 'error' }],
    })
    .eq('id', runId)
    .in('run_status', ['queued', 'running']);
}

/**
 * Closes the dead runs of ONE statement and reports the alive one, if any. `liveJobId` is the statement's own active job (a run of
 * that job is alive by definition).
 */
export async function closeDeadParseRuns(
  admin: Admin,
  documentId: string,
  opts: { liveJobId?: string | null; nowMs?: number } = {},
): Promise<{ closed: number; alive: { id: string; started_at: string } | null }> {
  const nowMs = opts.nowMs ?? Date.now();
  const { data } = await admin.from('ii_document_parse_runs').select('id, started_at, idempotency_key').eq('source_document_id', documentId).in('run_status', ['queued', 'running']);
  const live = new Set<string>(opts.liveJobId ? [opts.liveJobId.toLowerCase()] : []);
  let closed = 0;
  let alive: { id: string; started_at: string } | null = null;
  for (const run of (data ?? []) as RunRow[]) {
    if (runIsAlive(run, live, nowMs)) {
      alive = { id: run.id, started_at: run.started_at };
      continue;
    }
    await closeRun(admin, run.id, nowMs);
    closed += 1;
  }
  return { closed, alive };
}

/**
 * The scheduled sweep: closes EVERY dead run of every user (cross-user by nature), so a run that nobody ever touches again does not
 * stay `running` forever. Returns how many were closed.
 */
export async function closeAllDeadParseRuns(admin: Admin, limit = 100, nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - JOBLESS_RUN_DEAD_AFTER_MS).toISOString();
  const { data } = await admin
    .from('ii_document_parse_runs')
    .select('id, started_at, idempotency_key, source_document_id')
    .in('run_status', ['queued', 'running'])
    .lt('started_at', cutoff)
    .order('started_at', { ascending: true })
    .limit(limit);
  const runs = (data ?? []) as Array<RunRow & { source_document_id: string }>;
  if (runs.length === 0) return 0;
  const docIds = [...new Set(runs.map((r) => r.source_document_id))];
  const liveJobIds = new Set<string>();
  for (let i = 0; i < docIds.length; i += 50) {
    const { data: jobs, error } = await admin.from('ii_statement_jobs').select('id').in('source_document_id', docIds.slice(i, i + 50)).in('status', ['queued', 'processing']);
    if (!error) for (const j of (jobs ?? []) as Array<{ id: string }>) liveJobIds.add(j.id.toLowerCase());
  }
  let closed = 0;
  for (const run of runs) {
    if (runIsAlive(run, liveJobIds, nowMs)) continue;
    await closeRun(admin, run.id, nowMs);
    closed += 1;
  }
  return closed;
}
