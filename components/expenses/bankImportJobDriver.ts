/**
 * Document2 (4) WP-G (F15) -- what the Expenses bank-statement panel does while a statement import JOB runs. Pure: the network and the
 * clock are injected, so the same code is unit-tested and used by the panel.
 *
 * The job is advanced by the browser asking `POST .../bank-import-jobs/{id}/advance` again and again; each answer is one bounded slice
 * of work plus the job's state. Asking is always safe (a second tab, a refresh, a retry after a dropped connection): the server holds a
 * lease, so exactly one caller works at a time and nothing is written twice.
 *
 *   - a slice that did work: ask again straight away (a short pause);
 *   - "busy" (another tab or the scheduled backstop holds the lease): wait a few seconds and ask again;
 *   - a gateway error / dropped connection: the slice may or may not have run; wait and ask again, up to a bound, never fail on it;
 *   - completed / needs a person / failed: stop and hand the final state back.
 */

export interface JobViewLike {
  job_id: string;
  document_id: string;
  status: 'queued' | 'processing' | 'review_required' | 'completed' | 'failed';
  phase: string;
  review_reason: 'ai_draft' | 'password' | null;
  progress_done: number;
  progress_total: number | null;
  message: string;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  keep_polling: boolean;
  liveness?: string;
}

export interface AdvanceAnswer {
  ok: boolean;
  status: number;
  json: { data?: { job?: JobViewLike; busy?: boolean; advanced?: boolean }; error?: string } | null | undefined;
}

export type DriveOutcome = 'completed' | 'needs_person' | 'failed' | 'cancelled' | 'gave_up';

export interface DriveResult {
  outcome: DriveOutcome;
  view: JobViewLike | null;
}

export const JOB_BUSY_WAIT_MS = 3_000;
export const JOB_BETWEEN_SLICES_MS = 400;
export const JOB_NETWORK_WAIT_MS = 4_000;
/** Consecutive unanswered asks tolerated before the panel says it lost the connection (the job itself is safe and carries on). */
export const JOB_MAX_CONSECUTIVE_NETWORK_FAILURES = 10;
/** A job older than the raw-file lifetime plus slack is not worth waiting for in one sitting. */
export const JOB_MAX_DRIVE_MS = 55 * 60_000;

export interface DriveOptions {
  jobId: string;
  advance: (jobId: string) => Promise<AdvanceAnswer>;
  wait: (ms: number) => Promise<void>;
  onUpdate?: (view: JobViewLike) => void;
  isCancelled?: () => boolean;
  now?: () => number;
  maxMs?: number;
}

/** An answer that means "no answer", not "the job failed". */
export function isUnansweredAsk(a: AdvanceAnswer): boolean {
  if (a.status === 0) return true;
  if (a.status === 502 || a.status === 503 || a.status === 504) return true;
  const empty = !a.json || Object.keys(a.json).length === 0;
  return a.status >= 500 && empty;
}

export async function driveBankImportJob(opts: DriveOptions): Promise<DriveResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const maxMs = opts.maxMs ?? JOB_MAX_DRIVE_MS;
  let last: JobViewLike | null = null;
  let unanswered = 0;
  for (;;) {
    if (opts.isCancelled?.()) return { outcome: 'cancelled', view: last };
    if (now() - started > maxMs) return { outcome: 'gave_up', view: last };
    const answer = await opts.advance(opts.jobId);
    if (isUnansweredAsk(answer)) {
      unanswered += 1;
      if (unanswered >= JOB_MAX_CONSECUTIVE_NETWORK_FAILURES) return { outcome: 'gave_up', view: last };
      await opts.wait(JOB_NETWORK_WAIT_MS);
      continue;
    }
    unanswered = 0;
    const view = answer.json?.data?.job ?? null;
    if (!answer.ok || !view) {
      // A real refusal (404: not yours / gone; 401: signed out): there is nothing to wait for.
      return { outcome: 'failed', view: last };
    }
    last = view;
    opts.onUpdate?.(view);
    if (view.status === 'completed') return { outcome: 'completed', view };
    if (view.status === 'failed') return { outcome: 'failed', view };
    if (view.status === 'review_required') return { outcome: 'needs_person', view };
    await opts.wait(answer.json?.data?.busy ? JOB_BUSY_WAIT_MS : JOB_BETWEEN_SLICES_MS);
  }
}

/** "Saving your transactions (1,250 of 3,000)" as a 0 to 100 figure, or null when the total is not known yet. */
export function jobProgressPercent(view: Pick<JobViewLike, 'progress_done' | 'progress_total' | 'status'>): number | null {
  if (view.status === 'completed') return 100;
  if (!view.progress_total || view.progress_total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((view.progress_done / view.progress_total) * 100)));
}
