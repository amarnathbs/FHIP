/**
 * Document2 (4) F15 -- a processing run the platform KILLED.
 *
 * Both bank processing services move a document `queued -> processing` before they read it and only leave `processing` at the very end (or
 * to `failed` inside their own catch). The hosting platform ends a request that runs past its limit (28 s) WITHOUT letting the handler run
 * its catch, so a long statement leaves the document in `processing` for ever, with whatever rows were already committed:
 *   - the PDF service then refused every retry ("cannot process while the document is processing"): a dead end the user could only meet
 *     as the generic "We could not process this bank statement";
 *   - the CSV service re-ran on top of the partial rows, which its own dedup index read as duplicates of the same statement (so the
 *     statement summary reported them as skipped duplicates and counted fewer rows than the file holds).
 *
 * THE RULE. A document in `processing` is either genuinely being read right now (a second concurrent run would double-write: refused with a
 * clear "still being read" answer) or its run is dead (older than any request could live: the partial rows are removed and the document
 * is started again cleanly). The cut-off is longer than the longest a request may run (`maxDuration` of the process routes, 60 s), so a live
 * run is never mistaken for a dead one.
 *
 * Pure so the routes, both services and the tests share it.
 */

/** Longer than a process request may live (the routes declare maxDuration = 60) plus slack for clock skew. */
export const PROCESSING_RUN_DEAD_AFTER_MS = 120_000;

export type ProcessingRunState = 'not_processing' | 'live' | 'dead';

export function processingRunState(
  doc: { processing_status: string; processing_started_at: string | null },
  nowMs: number = Date.now(),
): ProcessingRunState {
  if (doc.processing_status !== 'processing') return 'not_processing';
  const startedMs = doc.processing_started_at ? Date.parse(doc.processing_started_at) : NaN;
  if (!Number.isFinite(startedMs)) return 'dead';
  return nowMs - startedMs > PROCESSING_RUN_DEAD_AFTER_MS ? 'dead' : 'live';
}

/** What the user is told while another run of the same statement is still going. Plain words; nothing was lost. */
export const STATEMENT_STILL_BEING_READ_MESSAGE =
  'This statement is still being read. Nothing was lost. Wait a few seconds and check again; you do not need to upload it again.';
