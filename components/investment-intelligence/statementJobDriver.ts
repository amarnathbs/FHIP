/**
 * Document2 (4) WP-J -- what a screen does while a statement processing JOB runs. Pure: the network and the clock are injected, so the same
 * code is unit-tested and used by the screens (Statements & data, the replacement copy control, the Review centre).
 *
 * The job is advanced by the browser asking `POST .../statement-jobs/{id}/advance` again and again; each answer is one bounded slice of work
 * plus the job's state. Asking is always safe (a second tab, a refresh, a retry after a dropped connection): the server holds a lease, so
 * exactly one caller works at a time and nothing is written twice.
 *
 *   - a slice that did work: ask again straight away (a short pause);
 *   - "busy" (another tab or the scheduled backstop holds the lease): wait a few seconds and ask again;
 *   - a gateway error / dropped connection: the slice may or may not have run; wait and ask again, up to a bound, never fail on it;
 *   - completed / needs a person / failed: stop and hand the final state back.
 *
 * THE PASSWORD. The document password is needed by exactly one slice (the one that opens the file). The driver asks the caller for it only
 * while the job says it is still at that step (`password_step`); the caller holds it in memory and discards it as soon as the job leaves it.
 */

export interface StatementJobViewLike {
  job_id: string;
  document_id: string;
  job_kind: 'process' | 'reevaluate';
  status: 'queued' | 'processing' | 'review_required' | 'completed' | 'failed';
  phase: string;
  review_reason: 'password' | 'ai_review' | null;
  progress_done: number;
  progress_total: number | null;
  message: string;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  keep_polling: boolean;
  password_step: boolean;
  liveness?: string;
}

export interface AdvanceAnswer {
  ok: boolean;
  status: number;
  json: { data?: { job?: StatementJobViewLike; busy?: boolean; advanced?: boolean }; error?: string } | null | undefined;
}

export type DriveOutcome = 'completed' | 'needs_person' | 'failed' | 'cancelled' | 'gave_up';

export interface DriveResult {
  outcome: DriveOutcome;
  view: StatementJobViewLike | null;
}

export const JOB_BUSY_WAIT_MS = 3_000;
export const JOB_BETWEEN_SLICES_MS = 300;
export const JOB_NETWORK_WAIT_MS = 4_000;
/** Consecutive unanswered asks tolerated before the screen says it lost the connection (the job itself is safe and carries on). */
export const JOB_MAX_CONSECUTIVE_NETWORK_FAILURES = 10;
/** A job older than this is not worth waiting for in one sitting (the backstop and the next visit pick it up). */
export const JOB_MAX_DRIVE_MS = 55 * 60_000;

export interface DriveOptions {
  jobId: string;
  /** `sendPassword` is true while the job is still at the step that opens the file. */
  advance: (jobId: string, opts: { sendPassword: boolean }) => Promise<AdvanceAnswer>;
  wait: (ms: number) => Promise<void>;
  onUpdate?: (view: StatementJobViewLike) => void;
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

export async function driveStatementJob(opts: DriveOptions): Promise<DriveResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const maxMs = opts.maxMs ?? JOB_MAX_DRIVE_MS;
  let last: StatementJobViewLike | null = null;
  let unanswered = 0;
  for (;;) {
    if (opts.isCancelled?.()) return { outcome: 'cancelled', view: last };
    if (now() - started > maxMs) return { outcome: 'gave_up', view: last };
    const answer = await opts.advance(opts.jobId, { sendPassword: last ? last.password_step : true });
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

/** "Saving your transactions (28 of 100)" as a 0 to 100 figure, or null when the total is not known yet. */
export function jobProgressPercent(view: Pick<StatementJobViewLike, 'progress_done' | 'progress_total' | 'status'>): number | null {
  if (view.status === 'completed') return 100;
  if (!view.progress_total || view.progress_total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((view.progress_done / view.progress_total) * 100)));
}

/** What the screen says once the job has ended, in plain words (never a bare "failed"). Pure. */
export function describeJobEnd(outcome: DriveOutcome, view: StatementJobViewLike | null): { ok: boolean; text: string } {
  if (outcome === 'cancelled') return { ok: true, text: 'Still working in the background. You can leave this page; it continues.' };
  if (outcome === 'gave_up') return { ok: false, text: 'We lost the connection while this was running. It is saved and keeps going in the background; open this page again to see where it is.' };
  if (!view) return { ok: false, text: 'We could not follow this just now. Nothing was lost; open this page again to see where it is.' };
  if (view.status === 'completed') {
    const r = view.result as { reevaluated?: { evaluated: number; failed: number }; summary?: { transactionsFound?: number; holdingsFound?: number; reconciliationCasesOpened?: number; newTransactionsCount?: number; duplicateTransactionsLinked?: number } } | null;
    if (view.job_kind === 'reevaluate') {
      const e = r?.reevaluated;
      const n = e?.evaluated ?? 0;
      return { ok: (e?.failed ?? 0) === 0, text: `Re-evaluated ${n} position${n === 1 ? '' : 's'} from the retained data${e?.failed ? `; ${e.failed} could not be evaluated` : ''}.` };
    }
    const s = r?.summary;
    const parts = s ? `${s.transactionsFound ?? 0} transactions and ${s.holdingsFound ?? 0} holdings read` : 'Statement read';
    const cases = s?.reconciliationCasesOpened ?? 0;
    return { ok: true, text: `Done. ${parts}${s && (s.duplicateTransactionsLinked ?? 0) > 0 && (s.newTransactionsCount ?? 0) === 0 ? '; nothing was added twice' : ''}.${cases > 0 ? ` ${cases} item${cases === 1 ? '' : 's'} need${cases === 1 ? 's' : ''} your review.` : ' Review is ready.'}` };
  }
  if (view.status === 'review_required') {
    return { ok: false, text: view.review_reason === 'password' ? 'The password was missing or wrong. Enter the document password and try again.' : 'An AI-assisted reading is waiting for your check.' };
  }
  return { ok: false, text: view.error_message ?? ((view.result as { error?: string } | null)?.error ?? 'This statement could not be processed. Nothing was changed.') };
}
