/**
 * AIE-1.5 — backend-state -> user-facing-state mapping (AIE15-IA-01..07,
 * AIE15-IA-12, section 35's "Required user-state mapping" table).
 *
 * Pure function, unit-tested exhaustively against every value of
 * `AIE_RUN_STATUS` (lib/aie/types.ts) — this is
 * AIE15-TEST-01 ("unit-test mapping from backend states/reasons to user
 * state/questions/actions").
 */

import type { AieReconciliationOutcome, AieRunStatus } from '../types';
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

/** IA-11: honest empty/unavailable projection for an intake that never
 * produced a run at all (e.g. rejected at admission, or password-protected
 * and never processed). */
export function computeUserFacingStateForIntakeWithoutRun(intakeStatus: 'received' | 'quarantined' | 'rejected' | 'cancelled' | 'deleted'): AieUserFacingState {
  switch (intakeStatus) {
    case 'received':
    case 'quarantined':
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
