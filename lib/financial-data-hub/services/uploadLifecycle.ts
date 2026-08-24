/**
 * Financial Data Hub — FDH-3 upload-lifecycle orchestration.
 *
 * This is where a DECISION gets made and then persisted, per the
 * `services/index.ts` boundary comment. Every exported function here takes
 * an already-authenticated `userId` (the caller — an API route — has already
 * called `requireUser()`) and does its own ownership verification through
 * the normal RLS-scoped repositories before ever touching storage.
 *
 * NO SERVICE-ROLE CLIENT IS USED DIRECTLY IN THIS FILE. Storage writes go
 * through `services/storage.ts`; audit writes go through
 * `services/auditLog.ts`. Both are called only after this file's own
 * ownership checks (via `getForUser`, which is scoped by `user_id` at the
 * database) have already succeeded.
 */

import {
  ingestionJobsRepository,
  statementUploadsRepository,
  uploadSessionsRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import {
  createDocumentPreviewUrl,
  deleteDocumentObject,
  uploadDocumentObject,
  verifyDocumentObjectAbsent,
  verifyDocumentObjectExists,
} from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { validateUploadedFile } from '../domain/fileValidation';
import {
  assertSessionIsLive,
  buildOpaqueStorageKey,
  computeSessionExpiry,
  FdhUploadSessionError,
} from '../domain/uploadSession';
import { deriveUploadSubstate, deriveDocumentStatusLabel } from '../domain/uploadSubstate';
import { buildStatementUploadPurgePatch } from '../domain/privacy';
import type { FdhCreateUploadSessionInput } from '../validation/uploadSession';
import type { FdhStatementUpload } from '../domain/types';

export class FdhUploadLifecycleError extends Error {
  constructor(
    readonly code:
      | 'rate_limited'
      | 'not_found'
      | 'session_error'
      | 'upload_incomplete'
      | 'already_purged',
    message: string,
  ) {
    super(message);
    this.name = 'FdhUploadLifecycleError';
  }
}

/** Spec section 93 — a sensible, documented per-user limit rather than an
 * enterprise quota system. 20 upload-session creations per rolling hour is
 * far above any legitimate single-sitting document-upload session (a
 * household rarely has more than a handful of statements) and well below
 * what would meaningfully stress storage. */
export const MAX_UPLOAD_SESSIONS_PER_HOUR = 20;

async function assertNotRateLimited(userId: string): Promise<void> {
  const { data } = await uploadSessionsRepository.listForUser(userId, 200);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (data ?? []).filter((s) => new Date(s.created_at).getTime() >= oneHourAgo);
  if (recent.length >= MAX_UPLOAD_SESSIONS_PER_HOUR) {
    throw new FdhUploadLifecycleError('rate_limited', 'Too many uploads started recently. Try again in a little while.');
  }
}

/**
 * createUploadSession() — spec section 27.
 *
 * Creates the document metadata row (processing_status = 'created') and a
 * single-use, time-boxed upload session bound to it. Returns no storage
 * credential of any kind (spec section 26) — only an opaque `sessionId` the
 * browser will later pair with a `completeUpload()` call carrying the actual
 * bytes.
 */
export async function createUploadSession(userId: string, input: FdhCreateUploadSessionInput) {
  await assertNotRateLimited(userId);

  const { data: document, error: docError } = await statementUploadsRepository.create(userId, {
    household_id: null,
    source_type: input.source_type,
    document_type: input.document_type,
    institution_id: input.institution_id ?? null,
    country_code: input.country_code,
    currency_code: input.currency_code ?? null,
  });
  if (docError || !document) {
    throw new FdhUploadLifecycleError('session_error', docError?.message ?? 'could not create document record');
  }

  const now = new Date().toISOString();
  const storageKey = buildOpaqueStorageKey(userId, document.id);
  const { data: session, error: sessionError } = await uploadSessionsRepository.create(userId, {
    document_id: document.id,
    allowed_mime_type: input.declared_mime_type,
    expected_max_size_bytes: input.declared_file_size_bytes,
    storage_bucket: 'fdh-source-documents',
    storage_key: storageKey,
    upload_status: 'session_created',
    failure_code: null,
    expires_at: computeSessionExpiry(now),
  });
  if (sessionError || !session) {
    throw new FdhUploadLifecycleError('session_error', sessionError?.message ?? 'could not create upload session');
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: document.id,
    eventType: 'document_upload_created',
    actorType: 'user',
    actorId: userId,
    metadata: { document_type: input.document_type, source_type: input.source_type },
  });

  return { document, session };
}

/**
 * completeUpload() — spec section 27, 95-96.
 *
 * Receives the actual bytes (already read into memory by the API route —
 * bounded by the session's own `expected_max_size_bytes`, itself bounded by
 * `FDH_MAX_FILE_SIZE_BYTES`, so this is never an unbounded read). Never
 * trusts the browser's completion claim alone: validates the bytes
 * server-side, writes to storage, then VERIFIES the object actually exists
 * before transitioning the document out of `uploaded`.
 */
export async function completeUpload(
  userId: string,
  sessionId: string,
  bytes: Uint8Array,
): Promise<FdhStatementUpload> {
  const { data: session } = await uploadSessionsRepository.getForUser(userId, sessionId);
  if (!session) throw new FdhUploadLifecycleError('not_found', 'upload session not found');

  try {
    assertSessionIsLive(session, new Date().toISOString());
  } catch (e) {
    if (e instanceof FdhUploadSessionError) {
      await uploadSessionsRepository.update(userId, sessionId, {
        upload_status: 'expired',
        expired_at: new Date().toISOString(),
      } as never);
      throw new FdhUploadLifecycleError('session_error', e.message);
    }
    throw e;
  }

  const { data: document } = await statementUploadsRepository.getForUser(userId, session.document_id);
  if (!document) throw new FdhUploadLifecycleError('not_found', 'document not found');

  await uploadSessionsRepository.update(userId, sessionId, { upload_status: 'upload_in_progress' } as never);

  const validation = validateUploadedFile({
    declaredMimeType: session.allowed_mime_type,
    byteLength: bytes.byteLength,
    bytes,
  });

  if (!validation.ok) {
    await uploadSessionsRepository.update(userId, sessionId, {
      upload_status: 'failed',
      failure_code: validation.failureCode,
    } as never);
    const errorCode = validation.failureCode === 'file_too_large' ? 'unsupported_file_type' : validation.failureCode;
    const { data: failedDoc } = await statementUploadsRepository.update(userId, document.id, {
      processing_status: 'failed',
      error_code: errorCode,
    } as never);
    await recordDocumentAuditEvent({
      userId,
      documentId: document.id,
      eventType: 'document_rejected',
      actorType: 'system',
      metadata: { reason: validation.failureCode },
    });
    return failedDoc ?? document;
  }

  const upload = await uploadDocumentObject({
    storageKey: session.storage_key,
    bytes,
    contentType: validation.detectedMimeType,
  });
  if (!upload.ok) {
    await uploadSessionsRepository.update(userId, sessionId, {
      upload_status: 'failed',
      failure_code: 'storage_error',
    } as never);
    throw new FdhUploadLifecycleError('session_error', upload.message);
  }

  const verified = await verifyDocumentObjectExists(session.storage_key, bytes.byteLength);
  if (!verified.exists) {
    await uploadSessionsRepository.update(userId, sessionId, {
      upload_status: 'failed',
      failure_code: 'upload_incomplete',
    } as never);
    throw new FdhUploadLifecycleError('upload_incomplete', 'the uploaded file could not be verified in storage');
  }

  const nowIso = new Date().toISOString();
  await uploadSessionsRepository.update(userId, sessionId, {
    upload_status: 'upload_complete',
    completed_at: nowIso,
  } as never);

  // Duplicate detection (spec section 21) — soft flag, never blocks.
  const { data: sameHash } = await statementUploadsRepository.listForUser(userId, 500);
  const duplicateOf = (sameHash ?? []).find(
    (d) => d.file_hash === validation.fileHash && d.id !== document.id,
  );

  assertDocumentTransition(document.processing_status, 'uploaded');
  await statementUploadsRepository.update(userId, document.id, {
    processing_status: 'uploaded',
    uploaded_at: nowIso,
    mime_type: validation.detectedMimeType,
    file_size_bytes: bytes.byteLength,
    file_hash: validation.fileHash,
    raw_document_storage_reference: session.storage_key,
    duplicate_of_document_id: duplicateOf?.id ?? null,
  } as never);
  await recordDocumentAuditEvent({
    userId,
    documentId: document.id,
    eventType: 'document_upload_completed',
    actorType: 'user',
    actorId: userId,
    metadata: { possible_duplicate: Boolean(duplicateOf) },
  });

  assertDocumentTransition('uploaded', 'validating');
  await statementUploadsRepository.update(userId, document.id, { processing_status: 'validating' } as never);

  // Validation phase (spec section 22, 84): FDH-3 inspects structure only —
  // is this a plausible file, is it password-protected — never document
  // content. A password-protected PDF is a VALID upload; it is queued so a
  // future FDH-4/5 parser can ask the user for the password, rather than
  // failed outright.
  if (validation.passwordRequired) {
    // FDH-5 CHANGE (spec section 22): FDH-3 intentionally stopped at
    // detecting encryption and dead-ended a password-protected PDF at
    // 'rejected' — the module's OWN header comment above already promised
    // otherwise ("A password-protected PDF is a VALID upload; it is queued
    // so a future FDH-4/5 parser can ask the user for the password, rather
    // than failed outright") but the code had not yet been updated to match
    // when that comment was written. FDH-5 is the phase spec section 22
    // explicitly authorises to implement controlled password support, so
    // this now genuinely queues the document — 'validating' -> 'queued' was
    // already a legal FDH-1 lifecycle edge (`documentLifecycle.ts`), simply
    // never taken on this path before. `error_code: 'password_required'`
    // still records exactly why processing cannot proceed without a
    // password yet; `review_status: 'pending'` still surfaces it to the
    // user. The password itself is never asked for, received or stored
    // here — this function only marks the document ready for a LATER,
    // separate, transient password-bearing processing attempt
    // (`bankPdfProcessingService.ts`).
    assertDocumentTransition('validating', 'queued');
    const { data: queuedDoc } = await statementUploadsRepository.update(userId, document.id, {
      processing_status: 'queued',
      review_status: 'pending',
      error_code: 'password_required',
      validated_at: nowIso,
    } as never);
    await recordDocumentAuditEvent({
      userId,
      documentId: document.id,
      eventType: 'pdf_password_required',
      actorType: 'system',
    });
    await ingestionJobsRepository.create(userId, {
      statement_upload_id: document.id,
      job_type: 'document_extract',
      status: 'queued',
      attempt: 0,
      max_attempts: 3,
    } as never);
    await recordDocumentAuditEvent({
      userId,
      documentId: document.id,
      eventType: 'document_queued',
      actorType: 'system',
    });
    return queuedDoc as FdhStatementUpload;
  }

  assertDocumentTransition('validating', 'queued');
  const { data: queuedDoc } = await statementUploadsRepository.update(userId, document.id, {
    processing_status: 'queued',
    validated_at: nowIso,
  } as never);
  await recordDocumentAuditEvent({
    userId,
    documentId: document.id,
    eventType: 'document_validated',
    actorType: 'system',
  });

  // Processing-QUEUE HANDOFF (spec section 50) — the interface a future
  // FDH-4/5 parser worker will consume. No worker is implemented in FDH-3;
  // this only creates the job record. No raw file content is placed in the
  // job row — only identifiers.
  await ingestionJobsRepository.create(userId, {
    statement_upload_id: document.id,
    job_type: 'document_extract',
    status: 'queued',
    attempt: 0,
    max_attempts: 3,
  } as never);
  await recordDocumentAuditEvent({
    userId,
    documentId: document.id,
    eventType: 'document_queued',
    actorType: 'system',
  });

  return queuedDoc as FdhStatementUpload;
}

export async function getDocumentStatus(userId: string, documentId: string) {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new FdhUploadLifecycleError('not_found', 'document not found');
  const { data: sessions } = await uploadSessionsRepository.listForUser(userId, 10);
  const session = (sessions ?? []).find((s) => s.document_id === documentId) ?? null;
  return {
    document,
    substate: deriveUploadSubstate({
      sessionStatus: session?.upload_status ?? null,
      processingStatus: document.processing_status,
      errorCode: document.error_code,
    }),
    statusLabel: deriveDocumentStatusLabel(document.processing_status),
  };
}

export async function listDocuments(userId: string) {
  const { data } = await statementUploadsRepository.listForUser(userId, 200);
  return (data ?? []).map((document) => ({
    document,
    statusLabel: deriveDocumentStatusLabel(document.processing_status),
  }));
}

/**
 * userDeleteDocument() — spec section 47. Allowed before processing/approval
 * completes; schedules an immediate purge rather than deleting the metadata
 * row outright, so the same verified purge path (`services/purge.ts`) is the
 * only code path that ever removes a storage object.
 */
export async function userDeleteDocument(userId: string, documentId: string): Promise<void> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new FdhUploadLifecycleError('not_found', 'document not found');
  if (document.raw_document_purge_status === 'purged') {
    throw new FdhUploadLifecycleError('already_purged', 'this document has already been deleted');
  }

  if (document.processing_status === 'approved') {
    // An approved document is never "rejected" (spec section 47) — deletion
    // after approval goes straight into the purge lifecycle.
    assertDocumentTransition('approved', 'purge_pending');
    await statementUploadsRepository.update(userId, documentId, { processing_status: 'purge_pending' } as never);
  } else if (
    document.processing_status !== 'rejected' &&
    document.processing_status !== 'purge_pending' &&
    document.processing_status !== 'purged'
  ) {
    assertDocumentTransition(document.processing_status, 'rejected');
    await statementUploadsRepository.update(userId, documentId, { processing_status: 'rejected' } as never);
  }

  await statementUploadsRepository.update(userId, documentId, {
    raw_document_purge_status: 'pending',
    raw_document_purge_due_at: new Date().toISOString(),
    purge_reason: 'user_deleted',
  } as never);
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'document_user_deleted',
    actorType: 'user',
    actorId: userId,
  });
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'document_purge_scheduled',
    actorType: 'system',
  });
}

/**
 * requestDocumentPreview() — spec section 25/58/111 ("purged URL
 * unavailable" is a FAIL condition if violated). Refuses outright once the
 * document has been purged, or once purge has even begun — the object may
 * already be gone or mid-deletion.
 */
export async function requestDocumentPreview(userId: string, documentId: string): Promise<string> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new FdhUploadLifecycleError('not_found', 'document not found');
  if (
    document.raw_document_purge_status === 'purged' ||
    document.raw_document_purge_status === 'in_progress' ||
    !document.raw_document_storage_reference
  ) {
    throw new FdhUploadLifecycleError('already_purged', 'this document is no longer available for preview');
  }
  const result = await createDocumentPreviewUrl(document.raw_document_storage_reference);
  if (!result.ok) throw new FdhUploadLifecycleError('session_error', result.message);
  return result.url;
}

// Re-exported for the purge service and certification scripts, which need
// the same "delete then verify" pair without duplicating the storage import.
export { deleteDocumentObject, verifyDocumentObjectAbsent, buildStatementUploadPurgePatch };
