// Investment Intelligence -- controlled replacement copy of a statement whose raw file was deleted
// (Document2 (4) WP-B, F5/F6/F14, 20-10-2026; identity validation added by WP-H, 21-10-2026).
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
//
// WP-H (Document2 (4) closure): the new copy must also be plausibly the SAME LOGICAL STATEMENT. Before the file reference is switched
// it is read with the deterministic parsers (nothing is written) and compared with what the old statement retained (provider, document
// type, period, folios, schemes, owner; see replacementIdentity.ts for the rules and thresholds). A different statement is refused; a
// materially different period or folio set needs the person's explicit confirmation of exactly those differences; a signal the old
// statement did not retain is reported as not compared, never as agreement. With the real malware scan on, the scan verdict comes
// first: unscanned bytes are never parsed.

import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { generateObjectKey, uploadSourceDocumentObject, deleteSourceDocumentObject, validateUploadedFile } from './storage';
import { scanUploadedPdfForAdmission, uploadAdmissionFailureMessage } from './uploadAdmission';
import { scanReplacementCandidate, recordAdmittedReplacementScan } from './realScanAdmission';
import { scanRefusalHttp } from './scanRefusal';
import { replacementAllowed } from './caseLifecycle';
import {
  compareStatementIdentity,
  loadMembersReadOnly,
  loadRetainedIdentity,
  readCandidateIdentity,
  unconfirmedDifferences,
  unreadableCopyVerdict,
  type IdentityVerdict,
} from './replacementIdentity';

/** What the identity check found, in a shape the screen can show. Dates are already day-first plain words. */
export interface ReplacementIdentityReport {
  decision: IdentityVerdict['decision'];
  differences: { code: string; severity: 'reject' | 'confirm'; message: string }[];
  comparedOn: string[];
  notComparedOn: string[];
  candidateSummary: string;
}

export type ReplacementResult =
  | { ok: true; sourceDocumentId: string; status: string; checksumChanged: boolean; previousFilename: string | null; scanPending: boolean; identity: ReplacementIdentityReport }
  | { ok: false; httpStatus: number; code: string; message: string; existingDocumentId?: string; identity?: ReplacementIdentityReport };

const toReport = (v: IdentityVerdict): ReplacementIdentityReport => ({
  decision: v.decision,
  differences: v.differences.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
  comparedOn: v.comparedOn,
  notComparedOn: v.notComparedOn,
  candidateSummary: v.candidateSummary,
});

export async function replaceSourceDocumentFile(input: {
  userId: string;
  sourceDocumentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** The statement's document password, used ONLY to read the copy for the identity check. Never stored, never logged. */
  password?: string;
  /** Codes of the confirmable differences the person has seen and accepted. A rejection can never be confirmed. */
  confirmedDifferences?: string[];
}): Promise<ReplacementResult> {
  const { userId, sourceDocumentId, filename, mimeType, bytes } = input;
  const confirmed = input.confirmedDifferences ?? [];
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

  const hasScanColumns = 'malware_scan_status' in row;

  // The real malware scan comes first: nothing below parses bytes that have not been cleared, and a refused copy leaves the file reference
  // alone. WP-H2: the scan of a password-protected copy is run on its decrypted bytes (the password is used only to open it in memory),
  // and its state is kept on the row against this file's hash, so pressing again continues the same scan instead of starting over.
  const scanAdmission = await scanReplacementCandidate({ userId, sourceDocumentId, bytes, contentType: mimeType, contentHash: checksum, hasScanColumns, password: input.password });
  if (!scanAdmission.admitted) {
    if (scanAdmission.reason === 'password_required' || scanAdmission.reason === 'wrong_password') {
      return {
        ok: false,
        httpStatus: 422,
        code: scanAdmission.reason === 'password_required' ? 'password_required_for_check' : 'wrong_password_for_check',
        message:
          scanAdmission.reason === 'password_required'
            ? 'This file is password protected. Enter its password so we can open it for the safety check and check it is the same statement. The password is used only for this and is not stored. Nothing was changed.'
            : 'The password did not open this file, so it could not be checked. Enter the document password again. Nothing was changed.',
      };
    }
    const refusal = scanRefusalHttp(scanAdmission);
    return { ok: false, httpStatus: refusal.status, code: refusal.code, message: refusal.message };
  }

  // WP-H: is this copy plausibly the same logical statement? Read-only; runs BEFORE the file reference is switched.
  const candidate = await readCandidateIdentity({ bytes, mimeType, password: input.password });
  if (candidate.kind === 'password') {
    return {
      ok: false,
      httpStatus: 422,
      code: candidate.failure === 'password_required' ? 'password_required_for_check' : 'wrong_password_for_check',
      message:
        candidate.failure === 'password_required'
          ? 'This file is password protected. Enter its password so we can check it is the same statement. The password is used only for this check and is not stored. Nothing was changed.'
          : 'The password did not open this file, so we could not check it is the same statement. Enter the document password again. Nothing was changed.',
    };
  }
  const retained = await loadRetainedIdentity(admin, userId, row);
  const verdict =
    candidate.kind === 'ok'
      ? compareStatementIdentity(retained, candidate.identity, await loadMembersReadOnly(admin, userId))
      : unreadableCopyVerdict(retained, candidate.reason);
  const unresolved = unconfirmedDifferences(verdict, confirmed);
  if (unresolved.length > 0) {
    const rejected = verdict.decision === 'rejected';
    await emitAuditEvent({
      userId,
      eventType: 'document_processing_failed',
      subjectType: 'ii_source_documents',
      subjectId: sourceDocumentId,
      actorType: 'system',
      metadata: {
        reason: rejected ? 'replacement_identity_rejected' : 'replacement_identity_needs_confirmation',
        differences: verdict.differences.map((d) => d.code),
        comparedOn: verdict.comparedOn,
        notComparedOn: verdict.notComparedOn,
      },
    });
    return {
      ok: false,
      httpStatus: rejected ? 422 : 409,
      code: rejected ? 'replacement_identity_conflict' : 'replacement_needs_confirmation',
      message: rejected
        ? `${unresolved.map((d) => d.message).join(' ')} Nothing was changed.`
        : `This copy differs from the statement it would replace. ${unresolved.map((d) => d.message).join(' ')} Nothing has been changed yet. Confirm only if this really is the same statement.`,
      identity: toReport(verdict),
    };
  }

  const objectKey = generateObjectKey(userId, filename);
  const { error: uploadErr } = await uploadSourceDocumentObject(objectKey, bytes, mimeType);
  if (uploadErr) return { ok: false, httpStatus: 500, code: 'storage_failed', message: `Storage upload failed: ${uploadErr}` };

  const previousFilename = (row.original_filename as string | null) ?? null;
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
    // A verdict already recorded for exactly this file (WP-H2) is kept; anything else is reset (the old verdict was for the old bytes).
    ...(hasScanColumns && !scanAdmission.recorded ? { malware_scan_status: 'not_required', malware_scan_object_ref: null, malware_scan_admission_deadline_at: null, malware_scan_decided_at: null } : {}),
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
      // WP-H: what the identity check compared, what it found, and which differences the person confirmed.
      identityCheck: {
        decision: verdict.decision,
        comparedOn: verdict.comparedOn,
        notComparedOn: verdict.notComparedOn,
        differences: verdict.differences.map((d) => d.code),
        confirmedDifferences: verdict.differences.filter((d) => d.severity === 'confirm' && confirmed.includes(d.code)).map((d) => d.code),
        previousPeriodStart: retained.periodStart,
        previousPeriodEnd: retained.periodEnd,
        newPeriodStart: candidate.kind === 'ok' ? candidate.identity.periodStart : null,
        newPeriodEnd: candidate.kind === 'ok' ? candidate.identity.periodEnd : null,
      },
    },
  });

  // The verdict reached before the copy was read is now recorded against the attached file (and the scan copy is deleted).
  if (!scanAdmission.recorded) await recordAdmittedReplacementScan(sourceDocumentId, scanAdmission.verdict);

  return {
    ok: true,
    sourceDocumentId,
    status: (patch.status as string | undefined) ?? ((row.status as string | undefined) ?? 'uploaded'),
    checksumChanged: previousChecksum !== checksum,
    previousFilename,
    scanPending: false,
    identity: toReport(verdict),
  };
}
