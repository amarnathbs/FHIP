/**
 * AIE-1.1 — the document-processing state machine (FSM-01..12).
 *
 * Split across two levels, matching the two-table split in migration 0140:
 *  - INTAKE level (`aie_document_intake.status`): the raw upload's own
 *    lifecycle, independent of any particular extraction attempt.
 *  - RUN level (`aie_extraction_run.status`): one extraction run's lifecycle
 *    from local extraction through to a terminal outcome. A single intake
 *    may have multiple runs over time (FSM-11: "define supersession on
 *    reprocessing").
 *
 * This mirrors `lib/financial-data-hub/domain/documentLifecycle.ts`'s own
 * "declare every legal edge once, enforce server-side, throw on anything
 * else" pattern exactly — the DB CHECK constraint enforces the VOCABULARY,
 * this module enforces the TRANSITIONS (same division of labour, same
 * rationale: "a constraint cannot express 'approved may not go back to
 * processing', and application code alone cannot stop a bad value being
 * written").
 */

import type { AieIntakeStatus, AieRunStatus } from './types';

export const AIE_INTAKE_TRANSITIONS: Record<AieIntakeStatus, readonly AieIntakeStatus[]> = {
  // M2 (H.1): `deleted` added to both. The retention/purge job's terminal
  // verdict must be reachable from EVERY non-deleted state -- the 24-hour
  // maximum-age guarantee cannot depend on which state a row stalled in, and
  // an upload that crashed while still `received` or `quarantined` is
  // exactly what `enforceAieRawFileHardBackstop` exists to clean up (it
  // selects on age alone, with no status filter). Omitting these edges did
  // not prevent anything -- `lib/aie/services/purge.ts` writes status
  // directly rather than through this table -- it only made the declared FSM
  // disagree with the job's real behaviour, which is how the corresponding
  // CHECK-constraint defect there went unnoticed.
  received: ['quarantined', 'rejected', 'cancelled', 'deleted'],
  quarantined: ['ready', 'rejected', 'deleted'],
  // M2 (H.1): `rejected` added. Admission to `ready` happens BEFORE local
  // text extraction is attempted, so extraction failure legitimately has to
  // reject an already-`ready` intake -- which both `app/api/aie/intake/
  // route.ts` and `app/api/aie/insurance/intake/route.ts` have always done.
  // The edge was missing from this table, so those were illegal transitions
  // taken in production; they only ever succeeded because nothing enforced
  // this table at runtime (see `updateIntakeStatus`). The correct fix is to
  // admit the edge the product genuinely needs rather than to contort the
  // routes: an intake whose bytes cannot be read is rejected, not cancelled
  // (cancellation is a USER action; rejection is a SYSTEM verdict) and not
  // deleted (deletion is the purge job's verdict, and must stay reachable
  // only from a settled state).
  ready: ['rejected', 'cancelled', 'deleted'],
  // Terminal for ordinary flow: only the retention/purge job may move a
  // rejected/cancelled intake on to deleted.
  rejected: ['deleted'],
  cancelled: ['deleted'],
  deleted: [],
};

export class AieInvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly machine: string,
  ) {
    super(`${machine}: transition ${from} -> ${to} is not allowed`);
    this.name = 'AieInvalidTransitionError';
  }
}

/**
 * M2 (H.1) fail-closed hardening. `AIE_INTAKE_TRANSITIONS[from]` is
 * `undefined` for a `from` value that is not in the table, and the previous
 * `[from].includes(to)` therefore threw a raw
 * `TypeError: Cannot read properties of undefined` rather than the module's
 * own `AieInvalidTransitionError`. That still failed closed (no write
 * occurred) but callers catching `AieInvalidTransitionError` misclassified
 * it as an unexpected crash. This matters because statuses come back out of
 * the database as untyped `text` and are cast unchecked (`repository.ts`
 * does `data.status as AieRunStatus`), so a legacy, hand-edited or
 * future-migration row genuinely can arrive here as an unknown literal.
 * An unrecognised state is now simply "no legal edges" -- refused, typed.
 */
export function isAllowedIntakeTransition(from: AieIntakeStatus, to: AieIntakeStatus): boolean {
  const allowed = AIE_INTAKE_TRANSITIONS[from] as readonly AieIntakeStatus[] | undefined;
  return allowed !== undefined && allowed.includes(to);
}

export function assertIntakeTransition(from: AieIntakeStatus, to: AieIntakeStatus): void {
  if (!isAllowedIntakeTransition(from, to)) {
    throw new AieInvalidTransitionError(from, to, 'aie intake lifecycle');
  }
}

/**
 * Run-level transitions. Happy path:
 *   local_extracting -> local_complete -> deterministic_complete
 *     -> reconciling -> awaiting_acceptance -> accepted -> write_pending -> completed
 *
 * Deterministic-partial path adds masking -> ai_pending -> ai_running ->
 * ai_complete before reconciling; a masking-policy failure diverts to the
 * terminal privacy_blocked state instead (never silently proceeds to AI).
 * A schema-invalid AI response diverts to schema_rejected, which is
 * recoverable (retry with a corrected/no AI attempt) rather than an
 * immediate terminal failure — AIE-1.1 section 21 permits "at most the
 * approved bounded syntactic repair attempt", modelled here as re-entering
 * `ai_pending` rather than a special repair state.
 */
export const AIE_RUN_TRANSITIONS: Record<AieRunStatus, readonly AieRunStatus[]> = {
  local_extracting: ['local_complete', 'failed_retryable', 'failed_terminal'],
  local_complete: ['deterministic_complete', 'deterministic_partial', 'failed_terminal'],
  deterministic_complete: ['reconciling', 'failed_terminal'],
  deterministic_partial: ['masking', 'reconciling', 'failed_terminal'],
  masking: ['ai_pending', 'privacy_blocked', 'reconciling', 'failed_terminal'],
  privacy_blocked: [],
  ai_pending: ['ai_running', 'failed_retryable', 'failed_terminal'],
  // 'reconciling' is directly reachable from ai_running (not only via
  // ai_complete/schema_rejected): a kill-switch block, a residual-PII
  // guard trip, a provider timeout/rate-limit/error, or a refusal all mean
  // "no usable AI data was produced" without ever reaching a schema
  // decision — deterministic candidates alone still proceed to
  // reconciliation rather than failing the whole run (GW-12).
  ai_running: ['ai_complete', 'schema_rejected', 'reconciling', 'failed_retryable', 'failed_terminal'],
  ai_complete: ['reconciling', 'failed_terminal'],
  schema_rejected: ['ai_pending', 'reconciling', 'failed_terminal'],
  reconciling: ['unresolved', 'awaiting_acceptance', 'failed_terminal'],
  unresolved: ['awaiting_acceptance', 'reconciling', 'failed_terminal'],
  // M3 (Phase 4) — `reconciling` added as a successor.
  //
  // WHY. `awaiting_acceptance` is the state `accept.ts` reads as "ready", so
  // a run must not sit there once blocking evidence exists. The Investment
  // Intelligence dispatch evaluates IDENTITY checks (ambiguous account,
  // ambiguous instrument, unstated owner, unusable statement period) after
  // the shared pipeline returns, because they are not arithmetic and are not
  // part of the reconciliation rule's inputs. A document can therefore pass
  // arithmetic reconciliation, reach `awaiting_acceptance`, and only then
  // acquire a blocking item — at which point it has to go back.
  //
  // Found by M3's live-DEV proof, not by inspection: the dispatch REPORTED
  // `unresolved` while the row in the database still read
  // `awaiting_acceptance`. That was safe in practice (the acceptance gate
  // independently re-checks the blocking count and the reconciliation
  // outcomes, and would have refused) but it is exactly the kind of
  // divergence between reported and stored state that a later reader, or a
  // later feature, would reasonably trust and be wrong about.
  //
  // Routed via `reconciling` rather than as a direct back-edge to
  // `unresolved`, matching `lib/aie/review/revalidate.ts`'s established
  // idiom for re-evaluating a run (`unresolved -> reconciling ->
  // unresolved | awaiting_acceptance`). One new edge, and the FSM keeps
  // saying that every arrival at `unresolved` came through reconciliation.
  awaiting_acceptance: ['accepted', 'reconciling', 'failed_terminal'],
  accepted: ['write_pending'],
  write_pending: ['completed', 'failed_retryable', 'failed_terminal'],
  completed: [],
  failed_retryable: ['local_extracting', 'ai_pending', 'reconciling', 'failed_terminal'],
  failed_terminal: [],
};

/** M2 (H.1): same fail-closed hardening as `isAllowedIntakeTransition`. */
export function isAllowedRunTransition(from: AieRunStatus, to: AieRunStatus): boolean {
  const allowed = AIE_RUN_TRANSITIONS[from] as readonly AieRunStatus[] | undefined;
  return allowed !== undefined && allowed.includes(to);
}

export function assertRunTransition(from: AieRunStatus, to: AieRunStatus): void {
  if (!isAllowedRunTransition(from, to)) {
    throw new AieInvalidTransitionError(from, to, 'aie extraction run lifecycle');
  }
}

/** M2 (H.1): an UNKNOWN status is deliberately NOT reported as terminal.
 * Terminality is used to decide that no further work is owed on a run;
 * answering "yes, finished" for a state this module does not recognise would
 * be the unsafe direction of the two. An unrecognised state is treated as
 * still-in-flight, which surfaces it rather than silently retiring it. */
export function isTerminalRunStatus(status: AieRunStatus): boolean {
  const allowed = AIE_RUN_TRANSITIONS[status] as readonly AieRunStatus[] | undefined;
  return allowed !== undefined && allowed.length === 0;
}
