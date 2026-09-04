/**
 * LR-1 — pure decision logic for the hard raw-retention backstop, split out
 * from `services/purge.ts#enforceRawFileHardBackstop` so it is unit-testable
 * without a Supabase client (mirrors this module's existing pattern of a
 * pure `domain/` decision layer under an I/O `services/` layer — see
 * `documentLifecycle.ts` and `privacy.ts`).
 *
 * Never reads or needs the raw file itself — only status columns and
 * timestamps already on the row.
 */
import { isAllowedDocumentTransition, isAllowedPurgeTransition } from './documentLifecycle';
import type { FdhProcessingStatus, FdhPurgeStatus } from '../constants/enums';

export interface RawFileBackstopInput {
  processingStatus: FdhProcessingStatus;
  purgeStatus: FdhPurgeStatus;
  /** ISO timestamp the document was received — `uploaded_at` with a
   * `created_at` fallback for a document that failed before an
   * `uploaded_at` stamp was ever set. */
  receivedAtIso: string;
  purgeDueAtIso: string | null;
}

export interface RawFileBackstopDecision {
  /** Force this new processing_status before scheduling the purge, or
   * `null` if no processing-status change is needed/allowed. */
  forceProcessingStatus: 'purge_pending' | 'rejected' | null;
  /** Whether a purge should be (re)scheduled immediately. */
  schedulePurgeNow: boolean;
}

/**
 * Decide what, if anything, the hard backstop must force for one document,
 * given the current time. Returns `null` when the document is still within
 * its allowed lifetime, already purged/mid-purge, or already scheduled and
 * due — i.e. nothing to force.
 */
export function decideRawFileBackstopAction(
  input: RawFileBackstopInput,
  nowMs: number,
  maxAgeMinutes: number,
): RawFileBackstopDecision | null {
  const receivedAtMs = new Date(input.receivedAtIso).getTime();
  const cutoffMs = nowMs - maxAgeMinutes * 60 * 1000;
  if (receivedAtMs > cutoffMs) return null; // still within the allowed lifetime

  if (input.purgeStatus === 'purged' || input.purgeStatus === 'in_progress') return null;

  // Already scheduled and due — the ordinary findDuePurges/runPurgeAttempt
  // sweep will pick this up on its own; nothing to force.
  if (input.purgeStatus === 'pending' && input.purgeDueAtIso && new Date(input.purgeDueAtIso).getTime() <= nowMs) {
    return null;
  }

  let forceProcessingStatus: RawFileBackstopDecision['forceProcessingStatus'] = null;
  if (input.processingStatus === 'approved') {
    if (isAllowedDocumentTransition('approved', 'purge_pending')) forceProcessingStatus = 'purge_pending';
  } else if (!['rejected', 'purge_pending', 'purged'].includes(input.processingStatus)) {
    if (isAllowedDocumentTransition(input.processingStatus, 'rejected')) forceProcessingStatus = 'rejected';
  }

  const schedulePurgeNow = isAllowedPurgeTransition(input.purgeStatus, 'pending');
  if (!schedulePurgeNow && !forceProcessingStatus) return null;

  return { forceProcessingStatus, schedulePurgeNow };
}
