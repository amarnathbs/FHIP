/**
 * PC5 (M4) — K.18: *"Decide and implement the previously open AIE-1.5
 * undo/amendment question. After canonical write, 'undo' must not silently
 * erase historical truth. Use governed amendment/supersession/removal
 * semantics consistent with the domain."*
 *
 * ================================================================
 * THE DECISION
 * ================================================================
 * **PC5 implements AMENDMENT-BY-SUPERSESSION, and does NOT implement
 * "undo".** There is no PC5 operation, at any point in the lifecycle, that
 * removes a record so that the system afterwards looks as though something
 * never happened. What a user can do instead depends on WHERE in the
 * lifecycle they are, and the boundary is the canonical write:
 *
 *   BEFORE the canonical write  -> DISCARD (`discard.ts`).
 *     The statement never became financial truth, so there is no historical
 *     truth to preserve. The run goes to `failed_terminal`, the intake to
 *     `cancelled`, the binary is purged, and an audit row records THAT a
 *     source was discarded and why — never what was in it. Nothing is
 *     erased because nothing was ever written.
 *
 *   AFTER the canonical write  -> SUPERSESSION, owned by Investment
 *     Intelligence, not by PC5.
 *     Once `accept.ts` has run, the holdings are `ii_transactions` /
 *     `ii_holding_snapshots` / `ii_source_documents` rows, and possibly
 *     `ii_fhip_publications` rows in the user's register. Those are
 *     Investment Intelligence's canonical tables, with their own
 *     already-certified supersession semantics:
 *       - `ii_source_documents.superseded_by_document_id` + status
 *         `'superseded'` (migration 0032 — its header states the rule
 *         verbatim: immutable, a revised statement is a NEW row, never an
 *         edit);
 *       - `ii_fhip_publications`'s bidirectional
 *         `supersedes_publication_id` / `superseded_by_publication_id`
 *         chain (migration 0042), driven by `unpublishPosition` /
 *         `republishPosition`;
 *       - `ii_transactions.corrects_transaction_id`, a self-reference for a
 *         correcting entry (migration 0033), on a table that has no
 *         `updated_at` at all because its rows are never updated.
 *     PC5 REUSES none of these by calling them, and REPLACES none of them.
 *     It refuses the operation and points at them.
 *
 *   IN-FLIGHT PC5 DECISIONS -> AMENDMENT.
 *     A user who chose the wrong owner, or the wrong account, or the wrong
 *     duplicate answer, and has not yet accepted, simply decides again. The
 *     previous decision row STAYS in `aie_review_decision` (that table has
 *     no update path and no delete path — `recordReviewDecision` only ever
 *     inserts), the new decision is appended, and re-reconciliation runs
 *     against the new answer. An ownership allocation amended this way
 *     marks its whole previous group `'superseded'` with
 *     `superseded_by_group_id` and `effective_to` stamped, and inserts a
 *     new group — never an in-place UPDATE (`allocationStore.ts`).
 *
 * ================================================================
 * WHY NOT BUILD A REAL POST-ACCEPTANCE UNDO IN PC5
 * ================================================================
 * Three reasons, in descending order of how much they should bother a
 * reviewer:
 *
 *   1. IT WOULD BE A SECOND WRITE PATH INTO CANONICAL TABLES. K.3 and
 *      K.20 both forbid PC5 writing canonical Investment Intelligence
 *      tables. An undo that removes accepted holdings is a canonical write
 *      by any other name — arguably the most dangerous one, since it
 *      deletes rather than inserts. Investment Intelligence's
 *      `unpublishPosition`/`republishPosition` already exist, are already
 *      certified, already emit the right audit events, and already handle
 *      the net-worth consequences. A PC5 copy would be a second
 *      implementation of the same semantics with none of that history.
 *
 *   2. THE BLAST RADIUS IS NOT THE STATEMENT. One accepted CAS statement
 *      can create instruments, accounts, transactions, holding snapshots,
 *      tax lots (FIFO, R6), publications, goal allocations and forecast
 *      inputs, and downstream engines have already read them. "Undo the
 *      statement" is therefore not one operation but a cascade whose
 *      correct shape is a domain question — e.g. whether tax lots
 *      consumed by a later disposal can be withdrawn at all — that this
 *      phase has no authority to answer. Guessing it and shipping it would
 *      be exactly the unauthorised scope creep this mission's boundaries
 *      exclude.
 *
 *   3. "UNDO" IS THE WRONG WORD FOR WHAT A USER ACTUALLY WANTS. The real
 *      requests behind it are "this was the wrong person" (which is
 *      discard, available before acceptance) and "this statement was
 *      replaced by a corrected one" (which is supersession, and which II
 *      already models). Offering a button labelled Undo would invite the
 *      third, dangerous reading — "make it as if I never imported it" —
 *      which is the silent erasure of historical truth K.18 prohibits in
 *      its own sentence.
 *
 * This module is therefore small on purpose: a policy table, a predicate,
 * and a typed refusal that names the right path. The enforcement is real —
 * `canAmend` is called by the routes — but the substance of the decision is
 * the absence of an undo, not the presence of code.
 */

import type { AieRunStatus } from '@/lib/aie/types';

export type Pc5AmendmentPath =
  /** Nothing canonical exists yet; the whole statement can be discarded. */
  | 'discard_before_acceptance'
  /** A prior PC5 decision can simply be decided again; the old one is kept. */
  | 'amend_decision_in_flight'
  /** Canonical rows exist. PC5 refuses; Investment Intelligence's own
   * supersession path owns it. */
  | 'ii_supersession_required'
  /** The run is in a transient write state. Nothing may be amended until it
   * settles, or the amendment would race the write. */
  | 'wait_for_write_to_settle'
  /** Already terminal and not accepted — nothing to amend. */
  | 'nothing_to_amend';

/**
 * TOTAL over `AieRunStatus` — the `never` check below fails compilation if
 * AIE adds a run status without this policy being revisited. That
 * exhaustiveness is the point: a new state silently falling into a default
 * branch is how an undo path gets created by accident.
 */
export function amendmentPathForRunStatus(status: AieRunStatus): Pc5AmendmentPath {
  switch (status) {
    case 'local_extracting':
    case 'local_complete':
    case 'deterministic_complete':
    case 'deterministic_partial':
    case 'masking':
    case 'ai_pending':
    case 'ai_running':
    case 'ai_complete':
    case 'schema_rejected':
    case 'reconciling':
      // Still processing. Discarding is legitimate (nothing canonical
      // exists), but there is no decision yet to amend.
      return 'discard_before_acceptance';

    case 'unresolved':
      return 'amend_decision_in_flight';

    case 'awaiting_acceptance':
      // Every exception is cleared but nothing is written. A user may still
      // discard, and may still revisit a decision that is no longer
      // blocking.
      return 'discard_before_acceptance';

    case 'accepted':
    case 'write_pending':
      return 'wait_for_write_to_settle';

    case 'completed':
      return 'ii_supersession_required';

    case 'privacy_blocked':
    case 'failed_terminal':
    case 'failed_retryable':
      return 'nothing_to_amend';

    default: {
      const exhaustive: never = status;
      throw new Error(`amendmentPathForRunStatus: unhandled AieRunStatus ${String(exhaustive)}`);
    }
  }
}

/** Plain-language guidance for each path, so the refusal a user sees names
 * the thing they should do instead rather than just saying no. */
export const PC5_AMENDMENT_GUIDANCE: Record<Pc5AmendmentPath, string> = {
  discard_before_acceptance:
    'Nothing from this statement has been saved to your portfolio yet, so you can discard it outright. Discarding deletes the original file and records that a statement was discarded — it does not touch anything already in your portfolio.',
  amend_decision_in_flight:
    'You can change your answer. Your earlier answer is kept in this statement’s history rather than overwritten, and the checks are re-run against the new one.',
  ii_supersession_required:
    'This statement has already been imported, so its holdings are part of your portfolio. Changing it now is a correction to your portfolio rather than an undo: upload the corrected statement, which supersedes this one, or unpublish the affected position from your register. Nothing is deleted from your history either way.',
  wait_for_write_to_settle:
    'This statement is being imported right now. Wait for it to finish before making changes, so a change cannot be applied halfway through.',
  nothing_to_amend: 'This statement was never imported, so there is nothing to change. You can upload it again if you need to.',
};

export function canAmendInFlight(status: AieRunStatus): boolean {
  const path = amendmentPathForRunStatus(status);
  return path === 'amend_decision_in_flight' || path === 'discard_before_acceptance';
}
