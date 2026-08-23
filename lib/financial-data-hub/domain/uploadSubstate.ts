/**
 * Financial Data Hub — FDH-3 UX upload substates (spec section 14).
 *
 * These are DISPLAY values only, derived from existing state — never a new
 * database column and never a new `processing_status` enum member. The spec
 * is explicit: "Prefer metadata fields over exploding the canonical
 * lifecycle enum unnecessarily." The canonical enum
 * (`domain/documentLifecycle.ts`) is unchanged; this module is the single,
 * documented mapping from it (plus the upload session and the failure code)
 * to what a user actually sees.
 */

import type { FdhErrorCode, FdhProcessingStatus } from '../constants/enums';
import type { FdhUploadSubstate } from '../constants/enums';
import type { FdhUploadSessionStatus } from '../constants/enums';

export function deriveUploadSubstate(input: {
  sessionStatus: FdhUploadSessionStatus | null;
  processingStatus: FdhProcessingStatus;
  errorCode: FdhErrorCode | null;
}): FdhUploadSubstate {
  const { sessionStatus, processingStatus, errorCode } = input;

  if (processingStatus === 'rejected' || processingStatus === 'failed') return 'FILE_REJECTED';
  if (errorCode === 'password_required' || errorCode === 'password_invalid') return 'FILE_REJECTED';

  if (sessionStatus === 'session_created') return 'UPLOAD_CREATED';
  if (sessionStatus === 'upload_in_progress') return 'UPLOAD_IN_PROGRESS';
  if (sessionStatus === 'failed' || sessionStatus === 'expired') return 'FILE_REJECTED';

  if (processingStatus === 'uploaded') return 'UPLOAD_COMPLETE';
  if (processingStatus === 'validating') return 'VALIDATION_PENDING';
  // queued and everything downstream means validation already passed.
  return 'VALIDATED';
}

/** A short, user-facing label (spec section 74 — "do not expose internal
 * enum names unnecessarily"). Intentionally does not mention parser
 * internals, job types or storage keys. */
export const UPLOAD_SUBSTATE_LABELS: Record<FdhUploadSubstate, string> = {
  UPLOAD_CREATED: 'Uploading',
  UPLOAD_IN_PROGRESS: 'Uploading',
  UPLOAD_COMPLETE: 'Validating',
  VALIDATION_PENDING: 'Validating',
  VALIDATED: 'Ready for processing',
  FILE_REJECTED: 'Needs attention',
};

/** Document-status labels for the full lifecycle (spec section 74), covering
 * the states beyond the upload substates above. */
export function deriveDocumentStatusLabel(processingStatus: FdhProcessingStatus): string {
  switch (processingStatus) {
    case 'created':
    case 'uploaded':
    case 'validating':
      return 'Uploading';
    case 'queued':
    case 'processing':
      return 'Ready for processing';
    case 'extracted':
    case 'review_required':
    case 'ready_for_approval':
      return 'Needs attention';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Deleted';
    case 'failed':
      return 'Failed';
    case 'purge_pending':
      return 'Scheduled for deletion';
    case 'purged':
      return 'Deleted';
    default:
      return 'Unknown';
  }
}
