/**
 * A bounded wall-clock wait (WP-08, UPL-01 / residual R-14-8).
 *
 * `pdf-parse` reads a PDF with no time limit of its own: a file that is not
 * really a PDF, or a hostile one, could keep a request (and the user staring
 * at "Processing your statement...") waiting until the platform killed it.
 * Every PDF read in the upload paths now runs inside a deadline and ends as
 * a controlled, retryable `extraction_timeout` instead.
 *
 * LIMIT, STATED PLAINLY. This bounds how long the CALLER waits; it cannot
 * pre-empt synchronous CPU work on the same thread. The caller also destroys
 * the parser on timeout, which stops pdf.js's asynchronous page loop at its
 * next yield. A hard kill would need a worker thread; that is not built here.
 *
 * Pure and dependency-free, so both lib/financial-data-hub and lib/aie can
 * use it without importing each other.
 */

export class DeadlineExceededError extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} did not finish within ${ms} ms`);
    this.name = 'DeadlineExceededError';
  }
}

/** Resolves or rejects with `work`, or rejects with DeadlineExceededError
 * after `ms`. A late rejection of `work` is swallowed (it is abandoned). */
export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), Math.max(0, ms));
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A deadline shared by several sequential steps: each step gets whatever
 * time is left of the whole budget. */
export function deadlineBudget(totalMs: number, now: () => number = Date.now) {
  const endsAt = now() + totalMs;
  return {
    run<T>(work: Promise<T>, label: string): Promise<T> {
      return withDeadline(work, endsAt - now(), label);
    },
  };
}
