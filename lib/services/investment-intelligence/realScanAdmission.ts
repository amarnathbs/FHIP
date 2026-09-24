/**
 * AIE-1 final production completion (2026-09-25) -- the real S3 + GuardDuty
 * malware gate for the Investment Intelligence source-document upload route.
 *
 * THE GAP. `POST /api/investment-intelligence/source-documents` is the only
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
 *      `processSourceDocument` reads any bytes. A pending scan is polled once
 *      more per call; the client retries on 409 `malware_scan_pending`
 *      (bounded, like the FDH panels). A document with no scan record while
 *      the scan is switched on (uploaded before this change) is scanned now,
 *      from its stored bytes, before anything parses it.
 *   3. Any blocking verdict marks the document `parse_failed` with a
 *      `malware_scan_*` parse_error and deletes its stored bytes (verified).
 *
 * With `AIE_REAL_MALWARE_SCAN_ENABLED` off, every function here is a no-op
 * that admits -- the route behaves exactly as before.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { isRealMalwareScanEnabled } from '@/lib/aie/malware/config';
import {
  initiateRealMalwareScan,
  continuePollingRealMalwareScan,
  type RealMalwareScanGateResult,
  type RealMalwareScanPersistedState,
} from '@/lib/aie/malware/realScanGate';
import { recordMalwareScanState, getMalwareScanState } from '@/lib/aie/malware/scanStateRepository';
import { downloadSourceDocumentObject } from './storage';
import { purgeSourceDocumentStorage } from './sourceDocumentPurge';
import { createHash } from 'crypto';

export type IiScanAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'pending' }
  | { admitted: false; reason: 'blocked'; status: string };

const BLOCKING = ['malicious', 'suspicious', 'scan_failed', 'scan_timeout', 'unknown'];

async function applyVerdict(userId: string, sourceDocumentId: string, storagePath: string | null, result: RealMalwareScanGateResult): Promise<IiScanAdmission> {
  if (result.status === 'not_required') return { admitted: true };
  if (result.persisted) {
    await recordMalwareScanState('ii_source_documents', sourceDocumentId, result.persisted as RealMalwareScanPersistedState);
  } else if (result.status === 'scan_failed') {
    await recordMalwareScanState('ii_source_documents', sourceDocumentId, { status: 'scan_failed', detail: result.detail ?? 'scan could not start' });
  }
  if (result.status === 'clean') return { admitted: true };
  if (result.status === 'pending') return { admitted: false, reason: 'pending' };
  await blockSourceDocument(userId, sourceDocumentId, storagePath, result.status);
  return { admitted: false, reason: 'blocked', status: result.status };
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

/** Called by the upload route right after the row and the stored object exist. */
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
    console.error('ii real-scan: migration 0196 is not applied; upload admitted on the structural check only');
    return { admitted: true };
  }
  const result = await initiateRealMalwareScan({
    pipeline: 'ii',
    userId: params.userId,
    documentId: params.sourceDocumentId,
    bytes: params.bytes,
    contentType: params.contentType,
    contentHash: params.contentHash,
  });
  return applyVerdict(params.userId, params.sourceDocumentId, params.storagePath, result);
}

/**
 * Called by the process route BEFORE `processSourceDocument` reads bytes.
 * Ownership is enforced by the `.eq('user_id', userId)` read.
 */
export async function ensureIiRealScanAdmissible(userId: string, sourceDocumentId: string): Promise<IiScanAdmission | { admitted: false; reason: 'not_found' }> {
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
  const row = doc as { storage_path: string | null; mime_type: string; parse_error: string | null; storage_purged_at: string | null; malware_scan_status?: string | null };
  if (!('malware_scan_status' in (doc as object))) {
    if (isRealMalwareScanEnabled()) {
      console.error('ii real-scan admission: migration 0196 is not applied; II uploads are structural-check only until it is');
    }
    return { admitted: true };
  }

  const status = row.malware_scan_status ?? 'not_required';
  if (status === 'clean') return { admitted: true };
  if (BLOCKING.includes(status)) return { admitted: false, reason: 'blocked', status };

  if (!isRealMalwareScanEnabled()) {
    // Structural-only mode (the documented default): unchanged behaviour.
    return { admitted: true };
  }

  if (status === 'pending') {
    const state = await getMalwareScanState('ii_source_documents', sourceDocumentId);
    if (!state?.ref || !state.expected) {
      await recordMalwareScanState('ii_source_documents', sourceDocumentId, { status: 'scan_failed', detail: 'pending scan has no object reference' });
      await blockSourceDocument(userId, sourceDocumentId, row.storage_path, 'scan_failed');
      return { admitted: false, reason: 'blocked', status: 'scan_failed' };
    }
    const result = await continuePollingRealMalwareScan({
      persisted: { status: 'pending', ref: state.ref, expected: state.expected },
    });
    return applyVerdict(userId, sourceDocumentId, row.storage_path, result);
  }

  // not_required while the scan is ON: these bytes were never scanned
  // (uploaded before this gate existed or while it was off). Scan them now,
  // from storage, before anything parses them.
  if (row.storage_purged_at || !row.storage_path) {
    // Nothing left to scan or to parse; processSourceDocument will report
    // the missing object itself.
    return { admitted: true };
  }
  const download = await downloadSourceDocumentObject(row.storage_path);
  if (!download.bytes) {
    return { admitted: true }; // processSourceDocument surfaces the download failure itself
  }
  const result = await initiateRealMalwareScan({
    pipeline: 'ii',
    userId,
    documentId: sourceDocumentId,
    bytes: download.bytes,
    contentType: row.mime_type,
    contentHash: createHash('sha256').update(download.bytes).digest('hex'),
  });
  return applyVerdict(userId, sourceDocumentId, row.storage_path, result);
}

/** User-facing copy: never reveals which verdict was reached. */
export const II_SCAN_PENDING_MESSAGE = 'Your document is being scanned for safety. This usually takes a few seconds.';
export const II_SCAN_BLOCKED_MESSAGE = 'This file could not be cleared by our security scan, so it was not processed and has been deleted. Please upload the document again.';
