/**
 * Document2 (4) F15 -- what the Expenses bank-statement panel does when the "process" request does not come back with an answer.
 *
 * The hosting platform ends a request after about 28 seconds. A long statement (above all a bank PDF that falls to the AI reading) runs
 * longer than that, so the browser got a gateway error (HTML, no JSON) or a dropped connection, and the panel said "We could not process
 * this bank statement." although the server was still working, or had finished and saved the result. The server side is retry-safe
 * (services/interruptedRun.ts: a live run answers 409 `statement_in_progress`, a finished AI reading is returned again without a second
 * call, a dead run is cleaned up and restarted), so the right client behaviour is to ask again, patiently and boundedly, and only then say
 * what happened in plain words.
 *
 * Pure so the panel and the tests share it.
 */

export type ProcessAttempt = { ok: boolean; status: number; json: Record<string, unknown> | null | undefined };

/** The answer means "not finished yet / no answer", not "this statement failed". */
export function isResumableProcessAttempt(a: ProcessAttempt): boolean {
  if (a.ok) return false;
  if (a.status === 409 && a.json?.error === 'statement_in_progress') return true;
  if (a.status === 0) return true; // the connection dropped
  if (a.status === 502 || a.status === 503 || a.status === 504) return true; // the platform's gateway ended the request
  const emptyBody = !a.json || Object.keys(a.json).length === 0;
  return a.status >= 500 && emptyBody; // a 5xx that carried no JSON came from the platform, not from our route
}

/** Wait between asks, and how long to keep asking in all (a dead run is restarted by the server after 120 s, so this covers one restart). */
export const PROCESS_RESUME_WAIT_MS = 5_000;
export const PROCESS_RESUME_MAX_ATTEMPTS = 30;

export const PROCESS_STILL_READING_MESSAGE =
  'Still reading your statement. A long statement can take a minute or two. Nothing is lost and you do not need to upload it again.';

export const PROCESS_TOO_LONG_MESSAGE =
  'This statement is taking longer to read than we can wait for here. Nothing was lost. Try again in a minute; if it keeps happening, download a CSV of the same statement from your bank and upload that instead.';
