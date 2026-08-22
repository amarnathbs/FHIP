/**
 * Financial Data Hub — the document lifecycle state machine.
 *
 * A document's `processing_status` may only move along the edges declared
 * here. No arbitrary status change is permitted. FDH-1 defines and validates
 * the machine; the SERVICES that will drive it (upload, extraction, approval,
 * purge) belong to FDH-3 and later.
 *
 * The database enforces the VOCABULARY (a `check (... in (...))` constraint on
 * `fdh_statement_uploads.processing_status`); this module enforces the
 * TRANSITIONS. Both halves are needed: a constraint cannot express "approved
 * may not go back to processing", and application code alone cannot stop a bad
 * value being written.
 */

import type { FdhProcessingStatus, FdhPurgeStatus } from '../constants/enums';

/**
 * The complete allowed-transition specification.
 *
 * Happy path:
 *   created → uploaded → validating → queued → processing → extracted
 *           → review_required → ready_for_approval → approved
 *   approved → purge_pending → purged
 *
 * `failed` is reachable from every stage that can actually fail, and is
 * recoverable by re-queueing (a layout fix or a corrected password should not
 * force a re-upload).
 *
 * `rejected` is a USER decision, reachable only once there is something for
 * the user to look at.
 */
export const DOCUMENT_STATUS_TRANSITIONS: Record<
  FdhProcessingStatus,
  readonly FdhProcessingStatus[]
> = {
  // FDH-3 ADDITION: 'rejected' is directly reachable from every pre-review
  // stage, not only from validating/review_required/ready_for_approval/failed
  // as FDH-1 originally defined it. FDH-1 shipped no upload route, so there
  // was no way to reach these states in practice and therefore no user
  // action to cancel from them. FDH-3's spec section 47 requires "allow the
  // user to delete a document before processing/approval where safe" at ANY
  // pre-approval stage — including immediately after upload, before
  // validation has even run. The original design note ("rejected is a USER
  // decision, reachable only once there is something for the user to look
  // at") still holds for the REVIEW meaning of rejection; this widening adds
  // the separate, equally legitimate CANCELLATION meaning
  // (`services/uploadLifecycle.ts`'s `userDeleteDocument`), which does not
  // require anything to have been extracted yet.
  created: ['uploaded', 'failed', 'rejected'],
  uploaded: ['validating', 'failed', 'rejected'],
  validating: ['queued', 'failed', 'rejected'],
  queued: ['processing', 'failed', 'rejected'],
  processing: ['extracted', 'review_required', 'failed', 'rejected'],
  extracted: ['review_required', 'ready_for_approval', 'failed', 'rejected'],
  review_required: ['ready_for_approval', 'rejected', 'failed'],
  ready_for_approval: ['approved', 'review_required', 'rejected'],
  // Terminal for processing. The only onward move is into the purge lifecycle.
  // An APPROVED document is never "rejected" — deleting one after approval is
  // a purge-lifecycle action, not a review decision (spec section 47: "do not
  // silently delete already-approved structured financial data unless that
  // is a separate user data-delete workflow" — FDH-3 implements no
  // extraction, so this edge exists for completeness but is not exercised by
  // any FDH-3 flow today).
  approved: ['purge_pending'],
  // Terminal.
  rejected: [],
  // Recoverable: a fixed parser or a supplied password re-queues the document.
  failed: ['queued', 'rejected'],
  purge_pending: ['purged', 'failed'],
  // Terminal.
  purged: [],
};

/** Statuses from which no onward transition exists. */
export const TERMINAL_DOCUMENT_STATUSES: readonly FdhProcessingStatus[] = [
  'rejected',
  'purged',
];

export function isAllowedDocumentTransition(
  from: FdhProcessingStatus,
  to: FdhProcessingStatus,
): boolean {
  return DOCUMENT_STATUS_TRANSITIONS[from].includes(to);
}

export class FdhInvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    machine: string,
  ) {
    super(`${machine}: transition ${from} -> ${to} is not allowed`);
    this.name = 'FdhInvalidTransitionError';
  }
}

/** Throws unless the transition is declared above. */
export function assertDocumentTransition(
  from: FdhProcessingStatus,
  to: FdhProcessingStatus,
): void {
  if (!isAllowedDocumentTransition(from, to)) {
    throw new FdhInvalidTransitionError(from, to, 'document lifecycle');
  }
}

/**
 * The raw-document purge lifecycle, which runs alongside (not inside) the
 * processing lifecycle: a document's metadata row lives on after its raw
 * bytes are gone.
 *
 * `legal_hold` is reachable only from `pending`, is terminal here, and is
 * DELIBERATELY not settable by anything FDH-1 ships. It exists so the schema
 * does not have to change when a hold mechanism is approved.
 */
export const PURGE_STATUS_TRANSITIONS: Record<FdhPurgeStatus, readonly FdhPurgeStatus[]> = {
  not_required: ['pending'],
  pending: ['in_progress', 'legal_hold'],
  in_progress: ['purged', 'failed'],
  // Retryable: a transient storage error must not strand a document forever.
  failed: ['pending', 'in_progress'],
  purged: [],
  legal_hold: [],
};

export function isAllowedPurgeTransition(from: FdhPurgeStatus, to: FdhPurgeStatus): boolean {
  return PURGE_STATUS_TRANSITIONS[from].includes(to);
}

export function assertPurgeTransition(from: FdhPurgeStatus, to: FdhPurgeStatus): void {
  if (!isAllowedPurgeTransition(from, to)) {
    throw new FdhInvalidTransitionError(from, to, 'raw document purge lifecycle');
  }
}

/**
 * A document is eligible for raw-document purge only once the user has
 * approved it. Purging before approval would destroy the evidence the user is
 * still being asked to check.
 */
export function isPurgeEligible(processingStatus: FdhProcessingStatus): boolean {
  return processingStatus === 'approved';
}
