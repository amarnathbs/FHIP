// Investment Intelligence -- controlled replacement copy of a statement whose raw file was deleted
// (Document2 (4) WP-B, F5/F6/F14, 20-10-2026).
//
// Statement files are temporary by design. When the person needs something that only the file can give (a password
// reprocess, applying an instrument choice, re-reading a statement that failed), the answer is NOT to restore raw
// retention and NOT to refuse the upload as a "duplicate". It is to attach the new copy to the SAME logical document:
//
//   * the same `ii_source_documents` row is kept (its id, owner, history, cases and every holding / transaction already
//     written stay exactly where they are) -- no second document, so nothing can be counted twice;
//   * only the file reference, checksum and size change; the previous file name and checksum prefix are recorded on the
//     audit trail so the lineage is visible;
//   * the real malware gate runs again on the new bytes (the previous verdict never carries over);
//   * the ordinary process route then reprocesses it. That path is already idempotent: transactions are matched by
//     fingerprint (duplicates are linked, not inserted), holdings upsert on (account, instrument, as-of date), and
//     cases are opened idempotently, so no duplicate holdings, transactions or net worth are produced.
//
// An accidental duplicate upload (the file is still stored, or the same bytes under a different document) is still
// refused by the ordinary upload route; this flow only exists for a document that has no stored file.

import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { generateObjectKey, uploadSourceDocumentObject, deleteSourceDocumentObject, validateUploadedFile } from './storage';
import { scanUploadedPdfForAdmission, uploadAdmissionFailureMessage } from './uploadAdmission';
import { startIiRealScan, II_SCAN_BLOCKED_MESSAGE, II_SCAN_UNAVAILABLE_MESSAGE } from './realScanAdmission';
import { replacementAllowed } from './caseLifecycle';

export type ReplacementResult =
  | { ok: true; sourceDocumentId: string; status: string; checksumChanged: boolean; previousFilename: string | null; scanPending: boolean }
  | { ok: false; httpStatus: number; code: string; message: string; existingDocumentId?: string };

export async function replaceSourceDocumentFile(input: {
  userId: string;
  sourceDocumentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<ReplacementResult> {
  const { userId, sourceDocumentId, filename, mimeType, bytes } = input;
  const validation = validateUploadedFile({ filename, mimeType, sizeBytes: bytes.byteLength });
  if (!validation.ok) return { ok: false, httpStatus: 422, code: 'invalid_file', message: validation.error ?? 'This file cannot be used.' };

  const admin = createAdminClient();
  const { data: doc } = await admin.from('ii_source_documents').select('*').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle();
  // 404, never "exists but not yours": the user_id filter makes the two indistinguishable.
  if (!doc) return { ok: false, httpStatus: 404, code: 'not_found', message: 'Statement not found.' };
  const row = doc as Record<string, unknown>;

  const allowed = replacementAllowed({
    status: (row.status as string | null) ?? null,
    storagePath: (row.storage_path as string | null) ?? null,
    storagePurgedAt: (row.storage_purged_at as string | null) ?? null,
  });
  if (!allowed.ok) return { ok: false, httpStatus: 409, code: 'replacement_not_allowed', message: allowed.reason };

  if (mimeType === 'application/pdf') {
    const admission = scanUploadedPdfForAdmission(bytes);
    if (!admission.ok) {
      await emitAuditEvent({
        userId,
        eventType: 'document_processing_failed',
        subjectType: 'ii_source_documents',
        subjectId: sourceDocumentId,
        actorType: 'system',
        metadata: { reason: 'replacement_admission_rejected', failureCode: admission.failureCode, structuralReasons: admission.reasons },
      });
      return { ok: false, httpStatus: 422, code: 'upload_admission_rejected', message: uploadAdmissionFailureMessage(admission.failureCode) };
    }
  }

  const checksum = createHash('sha256').update(bytes).digest('hex');
  const previousChecksum = (row.checksum as string | null) ?? null;

  // The same bytes may already belong to a DIFFERENT statement of this person (unique(user_id, checksum)). Say so and point at it.
  const { data: other } = await admin.from('ii_source_documents').select('id').eq('user_id', userId).eq('checksum', checksum).neq('id', sourceDocumentId).maybeSingle();
  if (other) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'file_belongs_to_another_statement',
      message: 'This exact file is already attached to a different statement of yours, so it was not attached here. Open that statement instead.',
      existingDocumentId: (other as { id: string }).id,
    };
  }

  const objectKey = generateObjectKey(userId, filename);
  const { error: uploadErr } = await uploadSourceDocumentObject(objectKey, bytes, mimeType);
  if (uploadErr) return { ok: false, httpStatus: 500, code: 'storage_failed', message: `Storage upload failed: ${uploadErr}` };

  const previousFilename = (row.original_filename as string | null) ?? null;
  const hasScanColumns = 'malware_scan_status' in row;
  const patch: Record<string, unknown> = {
    storage_path: objectKey,
    storage_purged_at: null,
    storage_purge_error: null,
    checksum,
    original_filename: filename,
    mime_type: mimeType,
    file_size: bytes.byteLength,
    // A discarded statement is revived by a replacement; every other status is left for the process run to settle.
    ...(row.status === 'archived' ? { status: 'uploaded', parse_error: null } : {}),
    // The previous verdict was for the previous bytes. Service-role write (migration 0196's guard only restrains `authenticated`).
    ...(hasScanColumns ? { malware_scan_status: 'not_required', malware_scan_object_ref: null, malware_scan_admission_deadline_at: null, malware_scan_decided_at: null } : {}),
  };
  const { error: updateErr } = await admin.from('ii_source_documents').update(patch).eq('id', sourceDocumentId).eq('user_id', userId);
  if (updateErr) {
    await deleteSourceDocumentObject(objectKey); // best effort: never leave an orphan object behind
    return { ok: false, httpStatus: 500, code: 'record_failed', message: 'The replacement could not be recorded. Nothing was changed.' };
  }

  await emitAuditEvent({
    userId,
    eventType: 'upload',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'user',
    actorId: userId,
    metadata: {
      controlledReplacement: true,
      replacementOf: sourceDocumentId,
      previousFilename,
      newFilename: filename,
      previousChecksumPrefix: previousChecksum ? previousChecksum.slice(0, 12) : null,
      newChecksumPrefix: checksum.slice(0, 12),
      checksumChanged: previousChecksum !== checksum,
      fileSize: bytes.byteLength,
      previousStatus: row.status ?? null,
    },
  });

  const scan = await startIiRealScan({ userId, sourceDocumentId, storagePath: objectKey, bytes, contentType: mimeType, contentHash: checksum, hasScanColumns });
  if (!scan.admitted && scan.reason === 'blocked') return { ok: false, httpStatus: 422, code: 'malware_scan_blocked', message: II_SCAN_BLOCKED_MESSAGE };
  if (!scan.admitted && scan.reason === 'scanner_unavailable') return { ok: false, httpStatus: 503, code: 'malware_scan_unavailable', message: II_SCAN_UNAVAILABLE_MESSAGE };

  return { ok: true, sourceDocumentId, status: (patch.status as string | undefined) ?? ((row.status as string | undefined) ?? 'uploaded'), checksumChanged: previousChecksum !== checksum, previousFilename, scanPending: !scan.admitted };
}
