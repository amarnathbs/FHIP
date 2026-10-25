/**
 * AIE-1 final production completion (2026-09-25) -- the real S3 + GuardDuty
 * malware gate for the Investment Intelligence source-document upload route.
 * Reworked 22-10-2026 (Document2 (4) WP-H2) for password-protected statements
 * and for honest, non-destructive handling of a scan that did not finish.
 *
 * THE GAP (original). `POST /api/investment-intelligence/source-documents` is the only
 * live II upload surface (the AIE II adapter route has no UI caller), and it
 * is open to every user in production. It ran only the structural PDF check
 * (`uploadAdmission.ts`), never the real scan that FDH-3 and the AIE intake
 * routes run, so a CAS statement PDF went from upload to pdf.js parsing on the
 * server without GuardDuty ever seeing it.
 *
 * THE DESIGN, deliberately without a new cron job. II already splits upload
 * and processing into two requests (the client calls /process right after
 * /upload), so:
 *   1. The upload route starts the scan (`startIiRealScan`): uploads the exact
 *      stored bytes to the malware-protection bucket, makes the gate's bounded
 *      inline poll, and records the verdict on the row (migration 0196 cols).
 *   2. The process route calls `ensureIiRealScanAdmissible` BEFORE
 *      `processSourceDocument` reads any bytes. A pending scan is polled again
 *      per call; the client retries on 409 `malware_scan_pending`
 *      (bounded, like the FDH panels). A document with no scan record while
 *      the scan is switched on (uploaded before this change, or deferred for a
 *      password, below) is scanned now, from its stored bytes, before anything
 *      parses it.
 *   3. A refusing verdict marks the document `parse_failed` with a
 *      `malware_scan_*` parse_error and deletes its stored bytes (verified)
 *      ONLY when it is a finding about the content (see scanRefusal.ts).
 *
 * WP-H2 (22-10-2026):
 *   * PASSWORD-PROTECTED STATEMENTS. GuardDuty cannot scan an encrypted PDF (UNSUPPORTED), and every CAMS / KFintech statement is one,
 *     so the scan refused every genuine statement. The scanner is now given the DECRYPTED bytes (scanPrepare.ts): at upload the
 *     password is not known yet, so the scan of such a file is deferred (nothing parses it, it only sits in private storage) and runs
 *     in the process call, which carries the password. Wrong or missing password is the ordinary password flow, never a scan verdict.
 *   * NOT-FINISHED IS NOT BLOCKED. A timeout, a scanner failure, a denied access to the scan copy and a configuration problem are
 *     `scanner_unavailable`: nothing is processed, NOTHING IS DELETED, the next call scans again. Only threats found and a file type
 *     the scanner cannot check are final.
 *   * Every refusal writes an audit event with a REASON CODE (never content, never a file name, never a password).
 *
 * With `AIE_REAL_MALWARE_SCAN_ENABLED` off, every function here is a no-op
 * that admits -- the route behaves exactly as before.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { isRealMalwareScanEnabled } from '@/lib/aie/malware/config';
import {
  initiateRealMalwareScan,
  continuePollingRealMalwareScan,
  REQUEST_POLL_BUDGET,
  type RealMalwareScanGateResult,
  type RealMalwareScanPersistedState,
} from '@/lib/aie/malware/realScanGate';
import { recordMalwareScanState, getMalwareScanState } from '@/lib/aie/malware/scanStateRepository';
import { checkPasswordAttemptRateLimit } from '@/lib/financial-data-hub/bank-pdf/password';
import { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR } from '@/lib/financial-data-hub/bank-pdf/constants';
import { downloadSourceDocumentObject } from './storage';
import { purgeSourceDocumentStorage } from './sourceDocumentPurge';
import { emitAuditEvent } from './audit';
import { prepareBytesForScan } from './scanPrepare';
import { classifyScanState, type ScanRefusalCode } from './scanRefusal';
import { createHash } from 'crypto';

// Kept as exports of this module for the many callers and tests that already import them from here.
export {
  II_SCAN_PENDING_MESSAGE,
  II_SCAN_BLOCKED_MESSAGE,
  II_SCAN_UNAVAILABLE_MESSAGE,
  II_SCAN_UNSUPPORTED_MESSAGE,
  II_SCAN_INCOMPLETE_MESSAGE,
} from './scanRefusal';

export type IiScanAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'pending' }
  | { admitted: false; reason: 'blocked'; status: string; code: ScanRefusalCode }
  // Canonical-upload WP-12 (UPL-02): the real scan is switched ON but this
  // database cannot record a verdict (migration 0196 not applied), or the scan could
  // not give an answer. It fails CLOSED -- nothing is parsed -- but never destructive.
  | { admitted: false; reason: 'scanner_unavailable'; code: ScanRefusalCode }
  // WP-H2: the statement is password protected and the password is missing, wrong, unusable or rate limited. Not a scan verdict.
  | { admitted: false; reason: 'password_required' | 'wrong_password' | 'unreadable_protection' | 'password_rate_limited' };

type Refused = Exclude<IiScanAdmission, { admitted: true }>;

/** Reason code only: never content, a file name, a path or a password. */
async function auditScanRefusal(userId: string, sourceDocumentId: string | null, outcome: string, code: ScanRefusalCode, scanStatus: string | null): Promise<void> {
  await emitAuditEvent({
    userId,
    eventType: 'document_processing_failed',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    metadata: { reason: 'malware_scan_refused', outcome, refusal: code, scanStatus },
  });
}

async function applyVerdict(userId: string, sourceDocumentId: string, storagePath: string | null, result: RealMalwareScanGateResult): Promise<IiScanAdmission> {
  if (result.status === 'not_required') return { admitted: true };
  if (result.persisted) {
    await recordMalwareScanState('ii_source_documents', sourceDocumentId, result.persisted as RealMalwareScanPersistedState);
  } else if (result.status === 'scan_failed') {
    await recordMalwareScanState('ii_source_documents', sourceDocumentId, { status: 'scan_failed', detail: result.detail ?? 'scan could not start' });
  }
  if (result.status === 'clean') return { admitted: true };
  if (result.status === 'pending') return { admitted: false, reason: 'pending' };
  const state = classifyScanState(result.status, result.detail ?? result.persisted?.detail);
  if (state.cls === 'unavailable') {
    // The scan did not give an answer about the file: refuse (nothing is parsed) but keep the file; the next call scans again.
    await auditScanRefusal(userId, sourceDocumentId, 'unavailable', state.code, result.status);
    return { admitted: false, reason: 'scanner_unavailable', code: state.code };
  }
  const code: ScanRefusalCode = state.cls === 'blocked' ? state.code : 'unrecognised_result';
  await auditScanRefusal(userId, sourceDocumentId, 'blocked', code, result.status);
  await blockSourceDocument(userId, sourceDocumentId, storagePath, result.status);
  return { admitted: false, reason: 'blocked', status: result.status, code };
}

async function blockSourceDocument(userId: string, sourceDocumentId: string, storagePath: string | null, status: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ii_source_documents')
    .update({ status: 'parse_failed', parse_error: `malware_scan_${status}` })
    .eq('id', sourceDocumentId)
    .eq('user_id', userId)
    .select('id');
  if (error || !data || data.length === 0) {
    console.error(`ii real-scan block could not be recorded for ${sourceDocumentId}: ${error?.message ?? 'zero rows'}`);
  }
  // The blocked bytes are never kept: delete + verify (records
  // storage_purged_at or storage_purge_error on the row).
  if (storagePath) await purgeSourceDocumentStorage(admin, sourceDocumentId, storagePath);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Called by the upload route right after the row and the stored object exist.
 * A password-protected PDF whose password is not known here is NOT scanned now and NOT refused: it is admitted without a verdict and
 * scanned in the process call (which carries the password) before anything parses it.
 */
export async function startIiRealScan(params: {
  userId: string;
  sourceDocumentId: string;
  storagePath: string;
  bytes: Uint8Array;
  contentType: string;
  contentHash: string;
  /** Whether the inserted row carries the 0196 scan columns. */
  hasScanColumns: boolean;
}): Promise<IiScanAdmission> {
  if (!isRealMalwareScanEnabled()) return { admitted: true };
  if (!params.hasScanColumns) {
    console.error('ii real-scan: the scan is on but migration 0196 is not applied; refusing the upload (fail closed)');
    return { admitted: false, reason: 'scanner_unavailable', code: 'scanner_not_configured' };
  }
  const prepared = await prepareBytesForScan(params.bytes, params.contentType);
  if (prepared.kind === 'password_needed' || prepared.kind === 'wrong_password' || prepared.kind === 'cannot_decrypt') {
    return { admitted: true }; // deferred: the process call scans it with the password; nothing parses these bytes before then
  }
  const scanBytes = prepared.kind === 'decrypted' ? prepared.bytes : params.bytes;
  const result = await initiateRealMalwareScan({
    pipeline: 'ii',
    userId: params.userId,
    documentId: params.sourceDocumentId,
    bytes: scanBytes,
    contentType: params.contentType,
    contentHash: prepared.kind === 'decrypted' ? sha256(scanBytes) : params.contentHash,
  });
  return applyVerdict(params.userId, params.sourceDocumentId, params.storagePath, result);
}

// ---------------------------------------------------------------------------------------------------------------------
// Replacement copy (Document2 (4) WP-H, reworked by WP-H2)
// ---------------------------------------------------------------------------------------------------------------------

/** A clean verdict recorded for a candidate is reused for this long (the same file, pressed again). */
const CANDIDATE_VERDICT_REUSE_MS = 30 * 60 * 1000;

/**
 * The real scan for a REPLACEMENT copy, run BEFORE anything parses the bytes (the identity check reads them) and BEFORE the file
 * reference is switched. With the real scan switched off this admits without doing anything (the documented structural-only mode).
 *
 * The scan state is PERSISTED on the document row against the copy's SHA-256 (`candidateHash`), so a second press with the same file
 * continues the SAME scan (same S3 object, no second upload) and a clean verdict reached between presses is admitted. The row's file
 * reference is still the old (deleted) file's; the scan fields of such a row describe only this candidate until it is attached or another
 * file is tried. A password-protected copy is opened in memory with the supplied password and the decrypted bytes are what is scanned.
 */
export type ReplacementScanAdmission =
  | { admitted: true; verdict: RealMalwareScanGateResult | null; recorded: boolean }
  | Refused;

export async function scanReplacementCandidate(params: {
  userId: string;
  sourceDocumentId: string;
  bytes: Uint8Array;
  contentType: string;
  /** SHA-256 of the file exactly as uploaded. */
  contentHash: string;
  /** Whether the document row carries the 0196 scan columns. */
  hasScanColumns: boolean;
  /** Used only to open the PDF in memory; never stored, logged or sent anywhere. */
  password?: string;
}): Promise<ReplacementScanAdmission> {
  if (!isRealMalwareScanEnabled()) return { admitted: true, verdict: null, recorded: false };
  if (!params.hasScanColumns) {
    console.error('ii real-scan: the scan is on but migration 0196 is not applied; refusing the replacement copy (fail closed)');
    return { admitted: false, reason: 'scanner_unavailable', code: 'scanner_not_configured' };
  }

  const refuse = async (r: Refused, code: ScanRefusalCode, outcome: string, status: string | null): Promise<Refused> => {
    await auditScanRefusal(params.userId, params.sourceDocumentId, outcome, code, status);
    return r;
  };
  const fromGateResult = async (result: RealMalwareScanGateResult): Promise<ReplacementScanAdmission> => {
    // Persist the state (pending included) so the next press continues it, and so the reason is visible to an operator.
    if (result.persisted) await recordMalwareScanState('ii_source_documents', params.sourceDocumentId, result.persisted);
    else await recordMalwareScanState('ii_source_documents', params.sourceDocumentId, { status: 'scan_failed', detail: result.detail ?? 'scan could not start' });
    if (result.status === 'clean') return { admitted: true, verdict: result, recorded: true };
    if (result.status === 'pending') return { admitted: false, reason: 'pending' };
    const state = classifyScanState(result.status, result.detail ?? result.persisted?.detail);
    if (state.cls === 'unavailable') return refuse({ admitted: false, reason: 'scanner_unavailable', code: state.code }, state.code, 'unavailable', result.status);
    const code: ScanRefusalCode = state.cls === 'blocked' ? state.code : 'unrecognised_result';
    return refuse({ admitted: false, reason: 'blocked', status: result.status, code }, code, 'blocked', result.status);
  };

  // 1. Is there already a scan of THIS file on the row?
  const existing = await getMalwareScanState('ii_source_documents', params.sourceDocumentId);
  if (existing && existing.candidateHash === params.contentHash) {
    if (existing.status === 'clean' && existing.decidedAt && Date.now() - new Date(existing.decidedAt).getTime() < CANDIDATE_VERDICT_REUSE_MS) {
      return { admitted: true, verdict: null, recorded: true };
    }
    if (existing.status === 'pending' && existing.ref && existing.expected) {
      const continued = await continuePollingRealMalwareScan({
        persisted: { status: 'pending', ref: existing.ref, expected: existing.expected, candidateHash: params.contentHash },
        pollBudget: REQUEST_POLL_BUDGET,
      });
      return fromGateResult(continued);
    }
  }

  // 2. A fresh scan. A password-protected copy is opened in memory first.
  const prepared = await prepareBytesForScan(params.bytes, params.contentType, params.password);
  if (prepared.kind === 'password_needed') return { admitted: false, reason: 'password_required' };
  if (prepared.kind === 'wrong_password') return { admitted: false, reason: 'wrong_password' };
  if (prepared.kind === 'cannot_decrypt') return refuse({ admitted: false, reason: 'unreadable_protection' }, 'unreadable_protection', 'refused', null);
  const scanBytes = prepared.kind === 'decrypted' ? prepared.bytes : params.bytes;
  const result = await initiateRealMalwareScan({
    pipeline: 'ii',
    userId: params.userId,
    documentId: params.sourceDocumentId,
    bytes: scanBytes,
    contentType: params.contentType,
    contentHash: prepared.kind === 'decrypted' ? sha256(scanBytes) : params.contentHash,
    pollBudget: REQUEST_POLL_BUDGET,
    candidateHash: params.contentHash,
  });
  return fromGateResult(result);
}

/** Records the clean verdict of an attached replacement copy on its row when the scan did not already record it. */
export async function recordAdmittedReplacementScan(sourceDocumentId: string, verdict: RealMalwareScanGateResult | null): Promise<void> {
  if (verdict?.persisted) await recordMalwareScanState('ii_source_documents', sourceDocumentId, verdict.persisted as RealMalwareScanPersistedState);
}

// ---------------------------------------------------------------------------------------------------------------------
// The process call
// ---------------------------------------------------------------------------------------------------------------------

const PASSWORD_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/** The shared password limiter, counted on parse runs exactly as processSourceDocument does (one threshold, one window). */
async function passwordAttemptsAllowed(userId: string, sourceDocumentId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_document_parse_runs')
    .select('started_at')
    .eq('source_document_id', sourceDocumentId)
    .eq('user_id', userId)
    .eq('password_supplied', true)
    .gte('started_at', new Date(Date.now() - PASSWORD_ATTEMPT_WINDOW_MS).toISOString())
    .order('started_at', { ascending: false })
    .limit(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR + 1);
  return checkPasswordAttemptRateLimit({
    recentAuditEvents: (data ?? []).map((r) => ({ event_type: 'pdf_password_required', created_at: r.started_at as string })),
    nowIso: new Date().toISOString(),
  }).allowed;
}

async function recordWrongPasswordAttempt(userId: string, sourceDocumentId: string): Promise<void> {
  const admin = createAdminClient();
  // Only the fact that a password accompanied a failed attempt; never the value.
  await admin.from('ii_document_parse_runs').insert({
    user_id: userId,
    source_document_id: sourceDocumentId,
    parser_code: 'scan-gate',
    parser_version: 'pending',
    started_at: new Date().toISOString(),
    run_status: 'failed',
    completed_at: new Date().toISOString(),
    idempotency_key: `${sourceDocumentId}:scan-gate:${Math.random().toString(36).slice(2)}${Date.now()}`,
    password_supplied: true,
    password_required: true,
    errors: [{ code: 'wrong_password', message: 'password did not open the statement', severity: 'error' }],
  });
}

/**
 * Called by the process route BEFORE `processSourceDocument` reads bytes.
 * Ownership is enforced by the `.eq('user_id', userId)` read.
 * `opts.password` is used only to open a protected PDF in memory for the scan.
 */
export async function ensureIiRealScanAdmissible(
  userId: string,
  sourceDocumentId: string,
  opts: { password?: string } = {},
): Promise<IiScanAdmission | { admitted: false; reason: 'not_found' }> {
  const admin = createAdminClient();
  // `select('*')`, deliberately: if this code is deployed before migration
  // 0196 the scan columns do not exist, and naming them would turn every II
  // process call into "not found". Their absence is detected below instead.
  const { data: doc } = await admin
    .from('ii_source_documents')
    .select('*')
    .eq('id', sourceDocumentId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!doc) return { admitted: false, reason: 'not_found' };
  const row = doc as { storage_path: string | null; mime_type: string; parse_error: string | null; storage_purged_at: string | null; malware_scan_status?: string | null; malware_scan_object_ref?: { detail?: string } | null };
  if (!('malware_scan_status' in (doc as object))) {
    if (isRealMalwareScanEnabled()) {
      // UPL-02: fail closed -- the scan is on, so an unscannable document is
      // never parsed on the structural check alone.
      console.error('ii real-scan admission: the scan is on but migration 0196 is not applied; refusing to parse (fail closed)');
      return { admitted: false, reason: 'scanner_unavailable', code: 'scanner_not_configured' };
    }
    return { admitted: true };
  }

  const status = row.malware_scan_status ?? 'not_required';
  if (status === 'clean') return { admitted: true };
  const state = classifyScanState(status, row.malware_scan_object_ref?.detail ?? null);
  // A refusal about the CONTENT is final (the stored copy was already deleted when it was reached).
  if (state.cls === 'blocked') return { admitted: false, reason: 'blocked', status, code: state.code };

  if (!isRealMalwareScanEnabled()) {
    // Structural-only mode (the documented default): unchanged behaviour.
    return { admitted: true };
  }

  if (status === 'pending') {
    const scanState = await getMalwareScanState('ii_source_documents', sourceDocumentId);
    if (!scanState?.ref || !scanState.expected) {
      await recordMalwareScanState('ii_source_documents', sourceDocumentId, { status: 'scan_failed', detail: 'pending scan has no object reference' });
      await auditScanRefusal(userId, sourceDocumentId, 'unavailable', 'scan_failed', 'pending');
      return { admitted: false, reason: 'scanner_unavailable', code: 'scan_failed' };
    }
    const result = await continuePollingRealMalwareScan({
      persisted: { status: 'pending', ref: scanState.ref, expected: scanState.expected },
      pollBudget: REQUEST_POLL_BUDGET,
    });
    return applyVerdict(userId, sourceDocumentId, row.storage_path, result);
  }

  // `not_required` while the scan is ON (never scanned: uploaded before this gate existed, or deferred for a password) and an
  // `unavailable` earlier attempt (a timeout, a failure) are scanned NOW, from the stored bytes, before anything parses them.
  if (row.storage_purged_at || !row.storage_path) {
    // Nothing left to scan or to parse; processSourceDocument will report
    // the missing object itself.
    return { admitted: true };
  }
  const download = await downloadSourceDocumentObject(row.storage_path);
  if (!download.bytes) {
    return { admitted: true }; // processSourceDocument surfaces the download failure itself
  }

  const supplied = typeof opts.password === 'string' && opts.password.length > 0;
  if (supplied && !(await passwordAttemptsAllowed(userId, sourceDocumentId))) return { admitted: false, reason: 'password_rate_limited' };
  const prepared = await prepareBytesForScan(download.bytes, row.mime_type, opts.password);
  if (prepared.kind === 'password_needed') return { admitted: false, reason: 'password_required' };
  if (prepared.kind === 'wrong_password') {
    await recordWrongPasswordAttempt(userId, sourceDocumentId);
    return { admitted: false, reason: 'wrong_password' };
  }
  if (prepared.kind === 'cannot_decrypt') {
    await auditScanRefusal(userId, sourceDocumentId, 'refused', 'unreadable_protection', null);
    return { admitted: false, reason: 'unreadable_protection' };
  }
  const scanBytes = prepared.kind === 'decrypted' ? prepared.bytes : download.bytes;
  const result = await initiateRealMalwareScan({
    pipeline: 'ii',
    userId,
    documentId: sourceDocumentId,
    bytes: scanBytes,
    contentType: row.mime_type,
    contentHash: sha256(scanBytes),
    pollBudget: REQUEST_POLL_BUDGET,
  });
  return applyVerdict(userId, sourceDocumentId, row.storage_path, result);
}
