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
  received: ['quarantined', 'rejected', 'cancelled'],
  quarantined: ['ready', 'rejected'],
  ready: ['cancelled', 'deleted'],
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

export function isAllowedIntakeTransition(from: AieIntakeStatus, to: AieIntakeStatus): boolean {
  return AIE_INTAKE_TRANSITIONS[from].includes(to);
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
  awaiting_acceptance: ['accepted', 'failed_terminal'],
  accepted: ['write_pending'],
  write_pending: ['completed', 'failed_retryable', 'failed_terminal'],
  completed: [],
  failed_retryable: ['local_extracting', 'ai_pending', 'reconciling', 'failed_terminal'],
  failed_terminal: [],
};

export function isAllowedRunTransition(from: AieRunStatus, to: AieRunStatus): boolean {
  return AIE_RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: AieRunStatus, to: AieRunStatus): void {
  if (!isAllowedRunTransition(from, to)) {
    throw new AieInvalidTransitionError(from, to, 'aie extraction run lifecycle');
  }
}

export function isTerminalRunStatus(status: AieRunStatus): boolean {
  return AIE_RUN_TRANSITIONS[status].length === 0;
}
