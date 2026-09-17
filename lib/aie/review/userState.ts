/**
 * AIE-1.5 — backend-state -> user-facing-state mapping (AIE15-IA-01..07,
 * AIE15-IA-12, section 35's "Required user-state mapping" table).
 *
 * Pure function, unit-tested exhaustively against every value of
 * `AIE_RUN_STATUS` (lib/aie/types.ts) — this is
 * AIE15-TEST-01 ("unit-test mapping from backend states/reasons to user
 * state/questions/actions").
 */

import type { AieIntakeStatus, AieReconciliationOutcome, AieRunStatus } from '../types';
import type { AieUserFacingState } from './types';

export interface UserStateInput {
  runStatus: AieRunStatus;
  /** Worst reconciliation outcome from the most recent reconciliation pass
   * for this run (P4: no confidence input anywhere in this signature). */
  reconciliationOutcome: AieReconciliationOutcome;
  openBlockingItemCount: number;
  /** True once this run's accepted write has already been durably
   * committed to `aie_write_batch`/the adapter's own link table — lets
   * "write_pending that failed once but is retrying" be told apart from
   * "write_pending that is genuinely still in flight the first time." */
  hasEverReachedWritePending: boolean;
}

/**
 * IA-12: "map every backend state to one user state and permitted
 * actions." Every `AieRunStatus` value is handled explicitly (a
 * `never`-typed exhaustiveness check below fails to compile if
 * `lib/aie/types.ts` ever adds a new run status without this function being
 * updated — the same discipline `lib/aie/stateMachine.ts` already applies
 * to its own transition table).
 */
export function computeUserFacingState(input: UserStateInput): AieUserFacingState {
  const { runStatus, openBlockingItemCount } = input;

  switch (runStatus) {
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
      return 'processing';

    case 'privacy_blocked':
      return 'unable_to_process_safely';

    case 'unresolved':
      // IA-02: needs-your-review is defined by "material unresolved items
      // only." A run can only be in 'unresolved' because
      // blockingItemsForReconciliation created at least one blocking item,
      // so openBlockingItemCount should never legitimately be 0 here — but
      // if a caller's view is momentarily stale (a decision resolved the
      // last item and revalidation has not yet re-run), the honest answer
      // is still "processing" (a recheck is owed), never a false
      // "ready to accept" (TRI-11: never let a stale summary imply
      // acceptance is safe).
      return openBlockingItemCount > 0 ? 'needs_your_review' : 'processing';

    case 'awaiting_acceptance':
      // Symmetric safety check: never claim ready-to-accept while a
      // blocking item view is stale/inconsistent.
      return openBlockingItemCount > 0 ? 'needs_your_review' : 'ready_to_accept';

    case 'accepted':
    case 'write_pending':
      return 'accepted_importing';

    case 'completed':
      return 'completed';

    case 'failed_retryable':
      // IA-05/section 35: "Import failed safely" is defined for an
      // ALREADY-ACCEPTED batch that failed/is retrying. A pre-acceptance
      // retryable failure (e.g. a transient local-extraction hiccup before
      // the user ever saw a summary) is still honestly "processing" from
      // the user's point of view — nothing they accepted has failed.
      return input.hasEverReachedWritePending ? 'import_failed' : 'processing';

    case 'failed_terminal':
      return input.hasEverReachedWritePending ? 'import_failed' : 'unable_to_process_safely';

    default: {
      const _exhaustive: never = runStatus;
      throw new Error(`computeUserFacingState: unhandled AieRunStatus ${String(_exhaustive)}`);
    }
  }
}

/**
 * IA-11: honest empty/unavailable projection for an intake that never
 * produced a run at all (e.g. rejected at admission, or password-protected
 * and never processed).
 *
 * M12C (M2-OPEN-3) — the parameter is now `AieIntakeStatus`, the real
 * vocabulary, instead of an inline FIVE-member literal union that silently
 * omitted `'ready'`. Because the union was written out by hand rather than
 * taken from `lib/aie/types.ts`, the compiler had nothing to object to: the
 * `never` check below was exhaustive over the hand-written union, not over
 * the type the database actually produces. A `'ready'` intake therefore fell
 * through to `default:` and THREW.
 *
 * HONESTY ABOUT SEVERITY: this was latent, not live. At the time of the fix
 * this function had zero production callers (only its own unit test), so no
 * user ever saw the throw. It is worth fixing anyway precisely because it is
 * the projection a future caller would reach for, and `'ready'` with no run
 * is not an exotic state — five routes set the intake to `'ready'` and only
 * THEN create the run (`app/api/aie/intake/route.ts:118`,
 * `app/api/aie/insurance/intake/route.ts:160`,
 * `app/api/aie/fdh-bank/intake/route.ts:161`,
 * `app/api/aie/investment-intelligence/intake/route.ts:175`, and
 * `.../[intakeId]/process/route.ts:137`), so every AIE upload passes through
 * exactly this state, and a crash between the two leaves a row sitting in it.
 */
export function computeUserFacingStateForIntakeWithoutRun(intakeStatus: AieIntakeStatus): AieUserFacingState {
  switch (intakeStatus) {
    case 'received':
    case 'quarantined':
    // M2-OPEN-3: `'ready'` belongs with the other two PRE-RUN admission
    // states, and the reasoning is what makes it the only defensible answer:
    //
    //  - `'ready'` is the INTAKE's ADMISSION verdict — "these bytes were
    //    accepted for processing" — NOT a review verdict about extracted
    //    content. Reaching this function at all means no run exists, so
    //    there are no field candidates, no reconciliation outcome and
    //    nothing whatsoever to accept.
    //  - `'ready_to_accept'` is therefore WRONG, and wrong in the dangerous
    //    direction: it would invite the user to import a document nothing
    //    has extracted or reconciled. That is precisely the TRI-11 /
    //    AIE15-ACPT rule this module is built around ("never let a stale
    //    summary imply acceptance is safe"), and the near-collision between
    //    the DB value `ready` and the UI value `ready_to_accept` is most
    //    likely how the gap was overlooked in the first place.
    //  - `'unable_to_process_safely'` is equally WRONG, in the opposite
    //    direction: nothing has failed. The document was ADMITTED. Telling
    //    the user it cannot be processed would be a false negative that
    //    pushes them to delete and re-upload a document that is genuinely
    //    still in flight.
    //  - `'processing'` is the honest answer: admitted, run not yet created.
    //    From the user's side that is indistinguishable from `received` and
    //    `quarantined`, which is why it maps with them.
    //
    // A row genuinely stuck here (the process died between the status write
    // and the run insert) keeps reporting `processing` until the 24-hour
    // retention backstop purges it and moves it to `deleted`
    // (`lib/aie/services/purge.ts`'s `enforceAieRawFileHardBackstop`) — that
    // backstop, not this projection, is the mechanism that resolves a stuck
    // upload, and it is the same mechanism that already resolves a row stuck
    // in `received` or `quarantined`.
    case 'ready':
      return 'processing';
    case 'rejected':
    case 'cancelled':
    case 'deleted':
      return 'unable_to_process_safely';
    default: {
      const _exhaustive: never = intakeStatus;
      throw new Error(`computeUserFacingStateForIntakeWithoutRun: unhandled status ${String(_exhaustive)}`);
    }
  }
}
