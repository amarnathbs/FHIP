/**
 * Document2 (4) WP-J -- the Investment Intelligence STATEMENT JOB: states, budgets and the view a browser gets. Pure.
 *
 * WHY A JOB. The platform ends a web request after about 28 seconds and has no long-running worker. Processing a large consolidated
 * statement (or reprocessing it after a replacement copy) is therefore cut into short SLICES, each its own request and each well
 * under the limit. The progress lives in a database row (`ii_statement_jobs`, migration 0313), so any slice can resume where the
 * last one stopped. The same pattern as the bank statement import job (migration 0310).
 *
 * STATES (status)
 *   queued           admitted, nothing has run yet (or the next slice is due)
 *   processing       a slice holds the lease, or has held it and the next slice is due
 *   review_required  waiting for a PERSON: the PDF needs its password, or an AI reading needs checking
 *   completed        the statement was processed (it may still have positions needing attention: that is a result, not a failure)
 *   failed           stopped; `error_code` says why; a retry starts a new attempt
 *
 * STEPS (phase), in order
 *   read -> accounts -> owner -> schemes -> transactions -> holdings -> analyse -> certify -> finalize -> done
 * A `reevaluate` job runs only `certify` (it reads no file).
 *
 * DEAD JOBS. A slice that was killed leaves a lease nobody renews. When it runs out the job is stalled and the next poll (or the
 * scheduled backstop) claims it and carries on. That is the whole dead-job rule; there is no separate janitor.
 */

export type StatementJobStatus = 'queued' | 'processing' | 'review_required' | 'completed' | 'failed';
export type StatementJobKind = 'process' | 'reevaluate';
export type StatementJobPhase = 'read' | 'accounts' | 'owner' | 'schemes' | 'transactions' | 'holdings' | 'analyse' | 'certify' | 'finalize' | 'done';
export type StatementJobReviewReason = 'password' | 'ai_review';

export const STATEMENT_JOB_ACTIVE_STATUSES: readonly StatementJobStatus[] = ['queued', 'processing'];

/** Lease a slice takes: longer than any slice may run (the request limit is 28 s), short enough that a dead one is noticed quickly. */
export const STATEMENT_JOB_LEASE_SECONDS = 60;
/** How long a slice spends on actual work before it stops starting new units and hands over. The platform limit is 28 s. */
export const STATEMENT_JOB_SLICE_BUDGET_MS = 17_000;
/** Slices that may fail in a row (an exception, not "more to do") before the job stops and says so. */
export const STATEMENT_JOB_MAX_CONSECUTIVE_FAILURES = 3;
/** How long a browser should wait before asking again when another worker holds the lease. */
export const STATEMENT_JOB_POLL_WAIT_MS = 3_000;
/** Staging left behind by a finished or failed job is swept after this. */
export const STATEMENT_JOB_STAGING_TTL_MS = 24 * 60 * 60_000;
/** A job with no activity for this long, and no live lease, is ended as abandoned (its staging is removed). */
export const STATEMENT_JOB_ABANDONED_AFTER_MS = 24 * 60 * 60_000;
/** The scheduled backstop leaves a freshly admitted job alone for this long: the browser that admitted it is about to send the password. */
export const STATEMENT_JOB_FRESH_READ_GRACE_MS = 2 * 60_000;
/** A processing run with no job behind it (the old synchronous path) cannot outlive the platform request limit by much. */
export const JOBLESS_RUN_DEAD_AFTER_MS = 2 * 60_000;

export const STATEMENT_JOB_STEP_ORDER: readonly StatementJobPhase[] = ['read', 'accounts', 'owner', 'schemes', 'transactions', 'holdings', 'analyse', 'certify', 'finalize'];

/** Share of the whole job each step stands for, for the progress bar. They add up to 100. */
export const STATEMENT_JOB_STEP_WEIGHT: Record<Exclude<StatementJobPhase, 'done'>, number> = {
  read: 8,
  accounts: 8,
  owner: 4,
  schemes: 14,
  transactions: 28,
  holdings: 6,
  analyse: 6,
  certify: 24,
  finalize: 2,
};

export interface StatementJobRow {
  id: string;
  user_id: string;
  source_document_id: string;
  job_kind: StatementJobKind;
  idempotency_key: string;
  status: StatementJobStatus;
  phase: StatementJobPhase;
  review_reason: StatementJobReviewReason | null;
  checkpoint: Record<string, unknown>;
  progress_done: number;
  progress_total: number | null;
  attempt: number;
  consecutive_failures: number;
  slice_count: number;
  reclaim_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  last_slice_at: string | null;
  error_code: string | null;
  error_message_sanitised: string | null;
  result_summary: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Progress as a figure out of 100: the steps already done plus the share of the current step (cursor over total). */
export function statementJobProgress(phase: StatementJobPhase, withinStep: number | null = null): { done: number; total: number } {
  if (phase === 'done') return { done: 100, total: 100 };
  let done = 0;
  for (const step of STATEMENT_JOB_STEP_ORDER) {
    if (step === phase) break;
    done += STATEMENT_JOB_STEP_WEIGHT[step as Exclude<StatementJobPhase, 'done'>];
  }
  const w = STATEMENT_JOB_STEP_WEIGHT[phase as Exclude<StatementJobPhase, 'done'>] ?? 0;
  const frac = withinStep === null ? 0 : Math.max(0, Math.min(1, withinStep));
  return { done: Math.min(100, Math.round(done + w * frac)), total: 100 };
}

export type StatementJobLiveness = 'idle' | 'working' | 'stalled' | 'waiting_for_person' | 'finished';

export function statementJobLiveness(job: Pick<StatementJobRow, 'status' | 'lease_expires_at' | 'slice_count'>, nowMs: number = Date.now()): StatementJobLiveness {
  if (job.status === 'completed' || job.status === 'failed') return 'finished';
  if (job.status === 'review_required') return 'waiting_for_person';
  const lease = job.lease_expires_at ? Date.parse(job.lease_expires_at) : NaN;
  if (Number.isFinite(lease) && lease > nowMs) return 'working';
  if (Number.isFinite(lease) || job.slice_count > 0) return 'stalled';
  return 'idle';
}

/** The plain-words line a browser shows. Never includes content, identifiers or internal names. */
export function statementJobStatusMessage(job: Pick<StatementJobRow, 'status' | 'phase' | 'review_reason' | 'job_kind' | 'progress_done'>): string {
  switch (job.status) {
    case 'completed':
      return job.job_kind === 'reevaluate' ? 'All positions were re-evaluated.' : 'Your statement has been read and saved.';
    case 'failed':
      return 'This statement could not be processed.';
    case 'review_required':
      return job.review_reason === 'password'
        ? 'This PDF is password-protected. Enter its password to continue.'
        : 'We read your statement with AI help. Please check the result before anything is saved.';
    default:
      break;
  }
  const still = 'Still working: this large statement is processed in steps. You can leave this page; it continues.';
  switch (job.phase) {
    case 'read':
      return 'Reading your statement...';
    case 'accounts':
    case 'owner':
      return `Matching your folios and owners. ${still}`;
    case 'schemes':
      return `Matching your funds. ${still}`;
    case 'transactions':
      return `Saving your transactions. ${still}`;
    case 'holdings':
      return `Saving your holdings. ${still}`;
    case 'analyse':
      return `Comparing with what you already had. ${still}`;
    case 'certify':
      return job.job_kind === 'reevaluate' ? `Re-evaluating your positions. ${still}` : `Checking each position. ${still}`;
    case 'finalize':
      return 'Finishing...';
    default:
      return still;
  }
}

/** What a browser may see of a job: no lease token, no checkpoint internals, no owner. */
export interface StatementJobView {
  job_id: string;
  document_id: string;
  job_kind: StatementJobKind;
  status: StatementJobStatus;
  phase: StatementJobPhase;
  review_reason: StatementJobReviewReason | null;
  liveness: StatementJobLiveness;
  progress_done: number;
  progress_total: number | null;
  attempt: number;
  message: string;
  error_code: string | null;
  error_message: string | null;
  /** The finished answer: the same shape the process route used to answer inline (ok, status, summary, error ...). */
  result: Record<string, unknown> | null;
  needs_person: boolean;
  keep_polling: boolean;
  /** True when the browser must send the document password with its next slice (only while the file is still to be read). */
  password_step: boolean;
}

export function toStatementJobView(job: StatementJobRow, nowMs: number = Date.now()): StatementJobView {
  const liveness = statementJobLiveness(job, nowMs);
  return {
    job_id: job.id,
    document_id: job.source_document_id,
    job_kind: job.job_kind,
    status: job.status,
    phase: job.phase,
    review_reason: job.review_reason,
    liveness,
    progress_done: job.progress_done,
    progress_total: job.progress_total,
    attempt: job.attempt,
    message: statementJobStatusMessage(job),
    error_code: job.error_code,
    error_message: job.status === 'failed' ? job.error_message_sanitised : null,
    result: job.status === 'completed' || job.status === 'failed' || job.status === 'review_required' ? job.result_summary : null,
    needs_person: job.status === 'review_required',
    keep_polling: job.status === 'queued' || job.status === 'processing',
    password_step: job.job_kind === 'process' && job.phase === 'read' && (job.status === 'queued' || job.status === 'processing'),
  };
}

/** Sanitises a thrown message for storage and display: bounded, no paths, no long digit runs. */
export function sanitiseStatementJobError(message: unknown): string {
  const raw = typeof message === 'string' ? message : message instanceof Error ? message.message : 'The processing stopped unexpectedly.';
  return raw.replace(/[0-9]{7,}/g, '[number]').replace(/\s+/g, ' ').trim().slice(0, 300) || 'The processing stopped unexpectedly.';
}

/** Validates a client-supplied Idempotency-Key header (opaque, bounded, printable). */
export function normaliseStatementIdempotencyKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length < 8 || v.length > 120) return null;
  if (!/^[A-Za-z0-9._:\-]+$/.test(v)) return null;
  return v;
}
