/**
 * Document2 (4) WP-J -- the statement WORKER: one bounded, resumable SLICE at a time.
 *
 * WHAT A SLICE IS. `advanceStatementJob` claims the job's lease (one winner, database clock), runs the pipeline steps (statementPipeline.ts)
 * for a bounded time (STATEMENT_JOB_SLICE_BUDGET_MS, well under the platform's 28 s), checkpoints, and either hands the job on or
 * finishes it. It is called by (a) the signed-in browser's poll and (b) the scheduled backstop. Neither is a long-running process; each
 * call is an ordinary web request.
 *
 * IDEMPOTENT. A slice killed at ANY point is simply taken over by the next claim after its lease runs out; it redoes at most one unit of
 * one step, and every unit is idempotent (see the pipeline header). Every write to the job row is fenced by the lease token.
 *
 * THE PASSWORD. Only the `read` step ever needs the file and its password. The browser sends the password with the slice that runs that
 * step; it is held in memory for that one call and never written to the job row, the checkpoint or the staging. The backstop has no
 * password: a protected statement it reaches in the `read` step goes to review_required (password) and waits for the person.
 */

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  hydratePipelineState,
  pipelineProgress,
  runPipelineSlice,
  type PipelineEnv,
  type PipelineState,
  type PipelineStore,
  type ProcessSourceDocumentResult,
} from '../statementPipeline';
import type { AieDocumentProvider } from '../aiFallbackDocumentExtraction';
import { kickUserNavHistory } from '../pc6/userNavHistoryKick';
import { toPlain } from '../statementStaging';
import {
  STATEMENT_JOB_FRESH_READ_GRACE_MS,
  STATEMENT_JOB_MAX_CONSECUTIVE_FAILURES,
  STATEMENT_JOB_SLICE_BUDGET_MS,
  sanitiseStatementJobError,
  type StatementJobRow,
} from './model';
import { claimJob, claimNextJob, deleteChunks, finishJob, getChunk, getJobForUser, listChunks, putChunk, releaseForNextSlice, updateOwned } from './store';

export type AdvanceOutcome =
  | { kind: 'advanced'; job: StatementJobRow }
  | { kind: 'busy'; job: StatementJobRow }
  | { kind: 'not_runnable'; job: StatementJobRow }
  | { kind: 'not_found' };

export interface AdvanceOptions {
  /** The signed-in caller (browser poll). The backstop passes none: it claims jobs by themselves. */
  userId?: string;
  /** The document password for the `read` step of THIS call only. Never stored. */
  password?: string;
  sliceBudgetMs?: number;
  now?: () => number;
  owner?: string;
  aiProviderOverride?: AieDocumentProvider | null;
  /** Test seam: called at named points inside the steps; a test throws SimulatedSliceKill to stand for a process that died there. */
  fault?: (point: string) => void | Promise<void>;
}

/** Thrown by a test's fault hook: stands for a slice whose process died. The lease is left to run out, exactly as a real kill would. */
export class SimulatedSliceKill extends Error {
  constructor(point: string) {
    super(`simulated slice kill at ${point}`);
    this.name = 'SimulatedSliceKill';
  }
}

function dbStore(job: StatementJobRow): PipelineStore {
  const { id, user_id: userId } = job;
  return {
    put: (kind, seq, payload) => putChunk(id, userId, kind, seq, payload),
    get: async (kind, seq) => (await getChunk(id, userId, kind, seq))?.payload ?? null,
    list: async (kind) => (await listChunks(id, userId, kind)).map((c) => ({ seq: c.seq, payload: c.payload })),
    clear: async (kinds) => deleteChunks(id, userId, kinds),
  };
}

function checkpointPatch(state: PipelineState): Record<string, unknown> {
  const p = pipelineProgress(state);
  return { checkpoint: toPlain(state), phase: state.step, progress_done: p.done, progress_total: p.total };
}

async function settle(job: StatementJobRow, owner: string, state: PipelineState, result: ProcessSourceDocumentResult, now: () => number): Promise<void> {
  const base = { ...checkpointPatch(state), phase: 'done', result_summary: toPlain(result) as Record<string, unknown>, consecutive_failures: 0 };
  if (result.ok) {
    const done = await finishJob(job.id, owner, { ...base, status: 'completed', review_reason: null, progress_done: 100, progress_total: 100, error_code: null, error_message_sanitised: null, completed_at: new Date(now()).toISOString() });
    if (!done) return;
    await deleteChunks(job.id, job.user_id);
    // Once a statement is processed, start fetching the missing NAV history of THIS user's funds (after the answer, best effort).
    if (job.job_kind === 'process') kickUserNavHistory(job.user_id);
    return;
  }
  if (result.status === 'password_required') {
    await finishJob(job.id, owner, { ...base, phase: 'read', status: 'review_required', review_reason: 'password', error_code: 'password_required', error_message_sanitised: sanitiseStatementJobError(result.error) });
    await deleteChunks(job.id, job.user_id);
    return;
  }
  if (result.status === 'ai_review_pending') {
    await finishJob(job.id, owner, { ...base, status: 'review_required', review_reason: 'ai_review', error_code: null, error_message_sanitised: null });
    await deleteChunks(job.id, job.user_id);
    return;
  }
  const done = await finishJob(job.id, owner, { ...base, status: 'failed', review_reason: null, error_code: (result.status || 'failed').slice(0, 80), error_message_sanitised: sanitiseStatementJobError(result.error ?? 'The statement could not be processed.'), completed_at: new Date(now()).toISOString() });
  if (done) await deleteChunks(job.id, job.user_id);
}

/** A job that failed for good (repeated unexpected errors): its run is closed as failed with an honest reason, never left running. */
async function failForGood(job: StatementJobRow, owner: string, state: PipelineState, error: unknown, now: () => number): Promise<void> {
  const admin = createAdminClient();
  const message = 'We could not finish processing this statement. Nothing was lost; please try again.';
  if (state.parseRunId) {
    await admin
      .from('ii_document_parse_runs')
      .update({ run_status: 'failed', completed_at: new Date(now()).toISOString(), errors: [{ code: 'job_failed', message: sanitiseStatementJobError(error), severity: 'error' }] })
      .eq('id', state.parseRunId)
      .in('run_status', ['queued', 'running']);
  }
  const done = await finishJob(job.id, owner, {
    ...checkpointPatch(state),
    status: 'failed',
    review_reason: null,
    error_code: 'internal_error',
    error_message_sanitised: message,
    result_summary: toPlain({ ok: false, status: 'internal_error', parseRunId: state.parseRunId, error: message }),
    completed_at: new Date(now()).toISOString(),
  });
  if (done) await deleteChunks(job.id, job.user_id);
}

async function runClaimed(claimed: StatementJobRow, owner: string, opts: AdvanceOptions): Promise<StatementJobRow> {
  const now = opts.now ?? Date.now;
  const deadlineAt = now() + (opts.sliceBudgetMs ?? STATEMENT_JOB_SLICE_BUDGET_MS);
  const forceReparse = (claimed.checkpoint as { forceReparse?: boolean } | null)?.forceReparse === true;
  const state = hydratePipelineState(claimed.checkpoint, claimed.job_kind, forceReparse);
  const admin = createAdminClient();
  const env: PipelineEnv = {
    userId: claimed.user_id,
    documentId: claimed.source_document_id,
    admin,
    store: dbStore(claimed),
    state,
    save: async () => (await updateOwned(claimed.id, owner, checkpointPatch(state))) !== null,
    timeLeftMs: () => deadlineAt - now(),
    jobId: claimed.id,
    attempt: claimed.attempt,
    password: opts.password,
    aiProviderOverride: opts.aiProviderOverride,
    fault: opts.fault,
  };
  try {
    const out = await runPipelineSlice(env);
    if (out.kind === 'more') {
      await releaseForNextSlice(claimed.id, owner, checkpointPatch(state));
    } else if (out.kind === 'finished') {
      await settle(claimed, owner, state, out.result, now);
    }
    // 'lost': another slice took over; this one writes nothing more.
  } catch (e) {
    if (e instanceof SimulatedSliceKill) throw e; // a dead process records nothing
    const failures = claimed.consecutive_failures + 1;
    console.error('[statement-job] slice failed', { jobIdPrefix: claimed.id.slice(0, 8), step: state.step, failures, message: sanitiseStatementJobError(e) });
    try {
      if (failures >= STATEMENT_JOB_MAX_CONSECUTIVE_FAILURES) {
        await failForGood(claimed, owner, state, e, now);
      } else {
        await updateOwned(claimed.id, owner, {
          status: 'queued',
          lease_owner: null,
          lease_expires_at: null,
          consecutive_failures: failures,
          error_message_sanitised: sanitiseStatementJobError(e),
          last_slice_at: new Date(now()).toISOString(),
        });
      }
    } catch (inner) {
      // Even recording the failure failed: leave the lease to run out; the next claim takes over.
      console.error('[statement-job] could not record a slice failure', { message: sanitiseStatementJobError(inner) });
    }
  }
  const after = await getJobForUser(claimed.user_id, claimed.id);
  return after ?? claimed;
}

/**
 * Advances one job by one slice. Safe to call any number of times, from any number of tabs and from the backstop at once: exactly one
 * caller holds the lease; the others get `busy` and the job's current state.
 */
export async function advanceStatementJob(jobId: string, opts: AdvanceOptions = {}): Promise<AdvanceOutcome> {
  let current: StatementJobRow | null;
  if (opts.userId) {
    current = await getJobForUser(opts.userId, jobId);
  } else {
    const { data, error } = await createAdminClient().from('ii_statement_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw new Error(error.message);
    current = (data as StatementJobRow | null) ?? null;
  }
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'queued' && current.status !== 'processing') return { kind: 'not_runnable', job: current };
  const owner = opts.owner ?? randomUUID();
  const claimed = await claimJob(jobId, owner);
  if (!claimed) {
    const latest = (await getJobForUser(current.user_id, jobId)) ?? current;
    return { kind: 'busy', job: latest };
  }
  const job = await runClaimed(claimed, owner, opts);
  return { kind: 'advanced', job };
}

/** Backstop: claims the most overdue unfinished job nobody holds and advances it by one slice. null = nothing to do. */
export async function advanceNextStatementJob(opts: AdvanceOptions = {}): Promise<AdvanceOutcome | null> {
  const owner = opts.owner ?? randomUUID();
  const claimed = await claimNextJob(owner);
  if (!claimed) return null;
  // A job admitted moments ago is waiting for the browser that admitted it: that browser is about to send the document password with the
  // slice that opens the file, which the backstop cannot do. Leave it alone for a short grace period.
  const now = opts.now ?? Date.now;
  if (claimed.job_kind === 'process' && claimed.phase === 'read' && now() - Date.parse(claimed.created_at) < STATEMENT_JOB_FRESH_READ_GRACE_MS) {
    const released = await releaseForNextSlice(claimed.id, owner, {});
    return { kind: 'busy', job: released ?? claimed };
  }
  const job = await runClaimed(claimed, owner, opts);
  return { kind: 'advanced', job };
}
