/**
 * Premium Upload Entitlement -- where an already-admitted Financial Data Hub document is in its run, for the
 * downgrade policy (see lib/entitlements/financialDataImport.ts, `refuseUnlessImportRunMayStart`).
 *
 * A document can only exist because an admission path passed the Premium check (createUploadSession /
 * completeUpload are gated), so "the document exists and belongs to this user" is the proof of a legitimately
 * admitted run. This only decides whether a process / retry request would start NEW extraction work:
 *   queued          -> the first run of an admitted document (bounded continuation; allowed after a downgrade)
 *   failed          -> a retry (re-queues and parses / calls a provider again: Premium) -- EXCEPT a document that is only
 *                      waiting for its PDF password (`password_required` / `password_invalid`): that run has not read
 *                      anything yet, so supplying the password is the same bounded first run
 *   anything else   -> already past that point: the routes' own idempotency / invalid-state rules apply and no
 *                      new extraction starts
 *   no such document (or someone else's) -> 'unknown' (refused; never confirms that a document exists)
 */

import type { AdmittedRunPosition } from '@/lib/entitlements/financialDataImport';
import { statementUploadsRepository } from '../repositories';

const AWAITING_PASSWORD_ERROR_CODES: readonly string[] = ['password_required', 'password_invalid'];

export function runPositionForFdhStatus(status: string | null | undefined, errorCode?: string | null): AdmittedRunPosition {
  if (status === 'queued') return 'first_run';
  if (status === 'failed') return errorCode && AWAITING_PASSWORD_ERROR_CODES.includes(errorCode) ? 'first_run' : 'retry';
  if (typeof status === 'string' && status.length > 0) return 'in_flight';
  return 'unknown';
}

/** Reads the document through the RLS-scoped repository (`user_id` is enforced by the database, not by this code). */
export async function fdhDocumentRunPosition(userId: string, documentId: string): Promise<AdmittedRunPosition> {
  const { data } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!data) return 'unknown';
  const row = data as { processing_status?: string | null; error_code?: string | null };
  return runPositionForFdhStatus(row.processing_status, row.error_code);
}
