/**
 * Financial Data Hub — FDH-3 upload-session domain rules.
 *
 * Pure functions: no database access, no storage access, no clock mutation.
 * `nowIso` is always an explicit parameter so a test can assert exact
 * boundary behaviour without faking global time.
 */

import type { FdhUploadSessionStatus } from '../constants/enums';

/** Sessions expire — spec section 15: "An upload session must expire. Do not
 * leave reusable permanent upload credentials." 15 minutes is generous for a
 * multi-megabyte statement over a slow connection while still being a real,
 * short-lived credential rather than an indefinite one. */
export const UPLOAD_SESSION_TTL_MINUTES = 15;

export function computeSessionExpiry(createdAtIso: string): string {
  const created = new Date(createdAtIso);
  return new Date(created.getTime() + UPLOAD_SESSION_TTL_MINUTES * 60_000).toISOString();
}

export function isSessionExpired(expiresAtIso: string, nowIso: string): boolean {
  return new Date(nowIso).getTime() >= new Date(expiresAtIso).getTime();
}

/** Allowed `fdh_upload_sessions.upload_status` transitions, mirroring the
 * document lifecycle's own explicit-transition-table discipline
 * (`domain/documentLifecycle.ts`). */
export const UPLOAD_SESSION_TRANSITIONS: Record<
  FdhUploadSessionStatus,
  readonly FdhUploadSessionStatus[]
> = {
  session_created: ['upload_in_progress', 'upload_complete', 'expired', 'failed'],
  upload_in_progress: ['upload_complete', 'expired', 'failed'],
  // Terminal — a completed session is not reusable (spec section 94: a
  // duplicate/late completion callback must not silently re-run the upload).
  upload_complete: [],
  // Terminal.
  expired: [],
  // Terminal — a failed session must not be resurrected; the caller opens a
  // fresh session for a retry, which gets its own opaque storage key.
  failed: [],
};

export function isAllowedSessionTransition(
  from: FdhUploadSessionStatus,
  to: FdhUploadSessionStatus,
): boolean {
  return UPLOAD_SESSION_TRANSITIONS[from].includes(to);
}

export class FdhUploadSessionError extends Error {
  constructor(
    readonly code: 'expired' | 'invalid_transition' | 'already_completed',
    message: string,
  ) {
    super(message);
    this.name = 'FdhUploadSessionError';
  }
}

/**
 * The one check every completion/failure path must run first: is this
 * session still live? A late completion callback on an expired session (spec
 * section 96, race conditions) must be rejected rather than silently
 * accepted, however plausible the uploaded bytes look.
 */
export function assertSessionIsLive(session: {
  upload_status: FdhUploadSessionStatus;
  expires_at: string;
}, nowIso: string): void {
  if (session.upload_status === 'upload_complete') {
    throw new FdhUploadSessionError('already_completed', 'this upload session has already been completed');
  }
  if (session.upload_status === 'expired' || session.upload_status === 'failed') {
    throw new FdhUploadSessionError('invalid_transition', `upload session is already ${session.upload_status}`);
  }
  if (isSessionExpired(session.expires_at, nowIso)) {
    throw new FdhUploadSessionError('expired', 'this upload session has expired — start a new upload');
  }
}

/**
 * The opaque storage object key (spec section 12). Deliberately built from
 * only two UUIDs already under FHIP's control — never the original filename,
 * never an institution/account identifier, never an email address.
 *
 *   household/... is NOT used: this codebase's tenancy boundary is user_id,
 *   not household_id (see migration 0046's tenancy note) — the FDH-1
 *   convention is carried forward rather than inventing a household-keyed
 *   path the RLS model does not actually use.
 */
export function buildOpaqueStorageKey(userId: string, documentId: string): string {
  return `${userId}/${documentId}/${documentId}.bin`;
}

export const FDH_SOURCE_DOCUMENTS_BUCKET = 'fdh-source-documents';
