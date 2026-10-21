/**
 * Document2 (4) WP-G (F15, PO-D24-03) -- the bank-statement import JOB: states, budgets and the view a browser gets. Pure.
 *
 * WHY A JOB. The platform ends a web request after about 28 seconds and has no long-running worker. A statement import is
 * therefore cut into short SLICES (each a separate request, each well under the limit), and the progress lives in a database row
 * (`fdh_bank_import_jobs`, migration 0310) so any slice can resume where the last one stopped.
 *
 * STATES (status)
 *   queued           admitted, nothing has run yet (or a retry is waiting for its next slice)
 *   processing       a slice holds the lease, or has held it and the next slice is due
 *   review_required  the job is waiting for a PERSON (the AI reading needs checking, or the PDF needs its password)
 *   completed        the import finished (the statement itself may still want its lines reviewed, as before)
 *   failed           stopped; `error_code` says why; a retry starts a new attempt
 *
 * PHASES (what the next slice does)
 *   read            parse the file (CSV / certified PDF) and stage the plan; or prepare an AI reading
 *   ai_read         read the staged page groups through the AI, a few per slice
 *   ai_review       (review_required) the merged AI reading waits for the person
 *   plan_confirmed  the person confirmed the reading; build and stage the plan from it
 *   persist         write the staged lines, as many as fit in the slice
 *   finalize        reconcile, certify, raise review items, finish
 *   done            terminal
 *
 * DEAD JOBS. A slice that was killed leaves a lease that nobody renews. When it runs out the job is "stalled" and the next
 * poll (or the scheduled backstop) claims it and carries on. That is the whole dead-job rule; there is no separate janitor.
 */

export type BankImportJobStatus = 'queued' | 'processing' | 'review_required' | 'completed' | 'failed';
export type BankImportPhase = 'read' | 'ai_read' | 'ai_review' | 'plan_confirmed' | 'persist' | 'finalize' | 'done';
export type BankImportSourceKind = 'csv' | 'pdf';
export type BankImportReviewReason = 'ai_draft' | 'password';

export const BANK_IMPORT_ACTIVE_STATUSES: readonly BankImportJobStatus[] = ['queued', 'processing'];

/** Lease a slice takes: longer than any slice may run (the request limit is 28 s), short enough that a dead one is noticed quickly. */
export const BANK_IMPORT_LEASE_SECONDS = 60;
/** How long a slice spends on actual work before it stops starting new units and hands over. The platform limit is 28 s. */
export const BANK_IMPORT_SLICE_BUDGET_MS = 17_000;
/** Lines per insert statement, and lines per staged batch. */
export const BANK_IMPORT_INSERT_CHUNK = 250;
export const BANK_IMPORT_STAGE_CHUNK = 250;
/** Slices that may fail in a row (an exception, not "more to do") before the job stops and says so. */
export const BANK_IMPORT_MAX_CONSECUTIVE_FAILURES = 3;
/** AI reading: parts read in one slice (in parallel) and tries per part. */
export const BANK_IMPORT_AI_PARALLEL_PARTS = 4;
export const BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART = 3;
/** Hard bound on one AI call inside a slice (the provider default is 20 s with up to two retries: far too long for a slice). */
export const BANK_IMPORT_AI_CALL_TIMEOUT_MS = 15_000;
/** How long a browser should wait before asking again when another worker holds the lease. */
export const BANK_IMPORT_POLL_WAIT_MS = 3_000;
/** A job nobody has touched for this long while unfinished is reported as abandoned. */
export const BANK_IMPORT_ABANDONED_AFTER_MS = 30 * 60_000;
/** Staging left behind by a finished or failed job is swept after this. */
export const BANK_IMPORT_STAGING_TTL_MS = 24 * 60 * 60_000;

export interface BankImportJobRow {
  id: string;
  user_id: string;
  statement_upload_id: string;
  source_kind: BankImportSourceKind;
  idempotency_key: string;
  status: BankImportJobStatus;
  phase: BankImportPhase;
  review_reason: BankImportReviewReason | null;
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

export type BankImportLiveness = 'idle' | 'working' | 'stalled' | 'waiting_for_person' | 'finished';

/**
 * Is anything working on this job right now?
 *   working   a lease is held and has not run out
 *   stalled   unfinished, and the lease ran out (or never existed after a slice began): the next poll / backstop takes it over
 *   idle      queued and never claimed
 */
export function bankImportLiveness(job: Pick<BankImportJobRow, 'status' | 'lease_expires_at' | 'slice_count'>, nowMs: number = Date.now()): BankImportLiveness {
  if (job.status === 'completed' || job.status === 'failed') return 'finished';
  if (job.status === 'review_required') return 'waiting_for_person';
  const lease = job.lease_expires_at ? Date.parse(job.lease_expires_at) : NaN;
  if (Number.isFinite(lease) && lease > nowMs) return 'working';
  if (Number.isFinite(lease) || job.slice_count > 0) return 'stalled';
  return 'idle';
}

/** The plain-words line a browser shows. Never includes content, identifiers or internal names. */
export function bankImportStatusMessage(job: Pick<BankImportJobRow, 'status' | 'phase' | 'review_reason' | 'progress_done' | 'progress_total' | 'source_kind'>): string {
  const n = (v: number) => v.toLocaleString('en-AU');
  const of = job.progress_total ? ` (${n(job.progress_done)} of ${n(job.progress_total)})` : '';
  switch (job.status) {
    case 'completed':
      return 'Your statement has been read and saved.';
    case 'failed':
      return 'This statement could not be imported.';
    case 'review_required':
      return job.review_reason === 'password'
        ? 'This PDF is password-protected. Enter its password to continue.'
        : 'We read your statement. Please check the lines below before they are saved.';
    default:
      break;
  }
  switch (job.phase) {
    case 'read':
      return job.source_kind === 'csv' ? 'Reading your statement...' : 'Reading your statement...';
    case 'ai_read':
      return `Reading your statement in parts${of}. Nothing is lost if you close this page; it carries on.`;
    case 'plan_confirmed':
      return 'Preparing your checked lines...';
    case 'persist':
      return `Saving your transactions${of}. Nothing is lost if you close this page; it carries on.`;
    case 'finalize':
      return 'Checking the totals and finishing...';
    default:
      return 'Working on your statement...';
  }
}

/** What a browser may see of a job: no lease token, no checkpoint internals, no owner. */
export interface BankImportJobView {
  job_id: string;
  document_id: string;
  source_kind: BankImportSourceKind;
  status: BankImportJobStatus;
  phase: BankImportPhase;
  review_reason: BankImportReviewReason | null;
  liveness: BankImportLiveness;
  progress_done: number;
  progress_total: number | null;
  attempt: number;
  message: string;
  error_code: string | null;
  error_message: string | null;
  /** Present once the job finished (completed, or failed with an answer such as an unsupported layout), or while it waits for a
   * password: the same payload the process route used to answer inline. */
  result: Record<string, unknown> | null;
  /** True while a person (not the system) has to act. */
  needs_person: boolean;
  /** True when more slices are due and the browser should keep asking. */
  keep_polling: boolean;
}

export function toBankImportJobView(job: BankImportJobRow, nowMs: number = Date.now()): BankImportJobView {
  const liveness = bankImportLiveness(job, nowMs);
  return {
    job_id: job.id,
    document_id: job.statement_upload_id,
    source_kind: job.source_kind,
    status: job.status,
    phase: job.phase,
    review_reason: job.review_reason,
    liveness,
    progress_done: job.progress_done,
    progress_total: job.progress_total,
    attempt: job.attempt,
    message: bankImportStatusMessage(job),
    error_code: job.error_code,
    error_message: job.status === 'failed' ? job.error_message_sanitised : null,
    result: job.status === 'completed' || job.status === 'failed' || (job.status === 'review_required' && job.review_reason === 'password') ? job.result_summary : null,
    needs_person: job.status === 'review_required',
    keep_polling: job.status === 'queued' || job.status === 'processing',
  };
}

/** Sanitises a thrown message for storage and display: bounded, no paths, no long digit runs. */
export function sanitiseJobError(message: unknown): string {
  const raw = typeof message === 'string' ? message : message instanceof Error ? message.message : 'The import stopped unexpectedly.';
  return raw.replace(/[0-9]{7,}/g, '[number]').replace(/\s+/g, ' ').trim().slice(0, 300) || 'The import stopped unexpectedly.';
}

/** Deterministic idempotency key for an admission that supplied none: one job per document. */
export function defaultBankImportIdempotencyKey(documentId: string): string {
  return `bank-import:${documentId}`;
}

/** Validates a client-supplied Idempotency-Key header (opaque, bounded, printable). */
export function normaliseIdempotencyKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length < 8 || v.length > 120) return null;
  if (!/^[A-Za-z0-9._:\-]+$/.test(v)) return null;
  return v;
}
