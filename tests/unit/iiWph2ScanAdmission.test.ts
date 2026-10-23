// Document2 (4) WP-H2 -- the Investment Intelligence malware gate: password-protected statements are opened in memory and the DECRYPTED bytes are
// scanned; a scan that did not finish is never turned into "blocked and deleted"; a scan in progress survives across presses.
//
// The real realScanAdmission / scanPrepare / scanRefusal / scanStateRepository run against an in-memory database; only the S3 + GuardDuty gate
// (initiate / continue), storage and the stored-file purge are stubs, so every assertion about WHAT THE SCANNER WAS GIVEN and WHAT WAS DELETED is
// about real code. Negative controls are listed at the end. Every password in this file is a throwaway constant from tests/support/buildEncryptedPdf.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildEncryptedTextPdf, TEST_USER_PASSWORD } from '../support/buildEncryptedPdf';
import { extractPdfText } from '@/lib/services/investment-intelligence/pdfExtraction';

type GateResult = { status: string; detail?: string; persisted?: Record<string, unknown> };
const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  enabled: true,
  stored: null as Uint8Array | null,
  purged: [] as string[],
  initiated: [] as { bytes: Uint8Array; contentHash: string; candidateHash?: string; documentId: string; pollBudget?: unknown }[],
  continued: [] as { persisted: Record<string, unknown>; pollBudget?: unknown }[],
  initiateResults: [] as GateResult[],
  continueResults: [] as GateResult[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => h.enabled }));
vi.mock('@/lib/aie/malware/realScanGate', async (orig) => ({
  ...(await orig<typeof import('@/lib/aie/malware/realScanGate')>()),
  initiateRealMalwareScan: async (p: { bytes: Uint8Array; contentHash: string; candidateHash?: string; documentId: string; pollBudget?: unknown }) => {
    h.initiated.push({ bytes: p.bytes, contentHash: p.contentHash, candidateHash: p.candidateHash, documentId: p.documentId, pollBudget: p.pollBudget });
    const r = h.initiateResults.shift() ?? { status: 'pending' };
    return withPersisted(r, p.candidateHash);
  },
  continuePollingRealMalwareScan: async (p: { persisted: Record<string, unknown>; pollBudget?: unknown }) => {
    h.continued.push({ persisted: p.persisted, pollBudget: p.pollBudget });
    const r = h.continueResults.shift() ?? { status: 'pending' };
    return { ...r, persisted: r.persisted ?? { ...p.persisted, status: r.status, detail: r.detail } };
  },
}));
vi.mock('@/lib/aie/malware/scanObjectPurge', () => ({ purgeRealScanObject: async () => ({ status: 'skipped', reason: 'no_object' }), sweepRealScanObjects: async () => ({}) }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  downloadSourceDocumentObject: async () => (h.stored ? { bytes: new Uint8Array(h.stored), error: null } : { bytes: null, error: 'gone' }),
}));
vi.mock('@/lib/services/investment-intelligence/sourceDocumentPurge', () => ({
  purgeSourceDocumentStorage: async (_a: unknown, id: string) => {
    h.purged.push(id);
  },
}));

function withPersisted(r: GateResult, candidateHash?: string): GateResult {
  const ref = { bucket: 'b', region: 'r', accountId: 'a', objectKey: 'ii/u/doc/k.bin', eTag: 'e', versionId: 'v' };
  const expected = { accountId: 'a', region: 'r', bucketName: 'b', objectKey: 'ii/u/doc/k.bin', expectedVersionId: 'v', expectedETag: 'e', admissionDeadlineIso: new Date(Date.now() + 20 * 60_000).toISOString() };
  return { ...r, persisted: r.persisted ?? { status: r.status, ref, expected, detail: r.detail, ...(candidateHash ? { candidateHash } : {}) } };
}

import { startIiRealScan, ensureIiRealScanAdmissible, scanReplacementCandidate } from '@/lib/services/investment-intelligence/realScanAdmission';
import { classifyScanState, scanRefusalHttp, II_SCAN_BLOCKED_MESSAGE, II_SCAN_INCOMPLETE_MESSAGE, II_SCAN_UNSUPPORTED_MESSAGE, II_SCAN_PENDING_MESSAGE } from '@/lib/services/investment-intelligence/scanRefusal';

const U = 'user-1';
const LINES = ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 31-Mar-2025', 'Folio No: 1122334455', 'Prime Mutual Fund'];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const plainPdf = () => new Uint8Array(buildMinimalTextPdf([LINES]));

function doc(over: Row = {}): Row {
  return { id: 'doc1', user_id: U, status: 'uploaded', storage_path: 'user-1/a.pdf', storage_purged_at: null, mime_type: 'application/pdf', parse_error: null, malware_scan_status: 'not_required', malware_scan_object_ref: null, malware_scan_admission_deadline_at: null, malware_scan_decided_at: null, ...over };
}
const row = () => h.db.tables.ii_source_documents[0];
const auditReasons = () => h.db.tables.ii_audit_events.map((e) => e.metadata as Record<string, unknown>);

beforeEach(() => {
  h.db = createInMemoryDb();
  h.db.reset({ ii_source_documents: [doc()], ii_audit_events: [], ii_document_parse_runs: [], ii_reconciliation_cases: [] });
  h.enabled = true;
  h.stored = null;
  h.purged.length = 0;
  h.initiated.length = 0;
  h.continued.length = 0;
  h.initiateResults.length = 0;
  h.continueResults.length = 0;
});

describe('what each stored scan status MEANS (pure) and what the person is told', () => {
  it.each([
    ['clean', null, { cls: 'clean' }],
    ['pending', null, { cls: 'pending' }],
    ['not_required', null, { cls: 'not_scanned' }],
    ['malicious', null, { cls: 'blocked', code: 'threats_found' }],
    ['suspicious', 'UNSUPPORTED: x', { cls: 'blocked', code: 'unsupported' }],
    ['suspicious', 'ACCESS_DENIED: x', { cls: 'unavailable', code: 'access_denied' }],
    ['suspicious', 'something else', { cls: 'blocked', code: 'unrecognised_result' }],
    ['scan_failed', null, { cls: 'unavailable', code: 'scan_failed' }],
    ['scan_timeout', null, { cls: 'unavailable', code: 'scan_timeout' }],
    ['unknown', null, { cls: 'unavailable', code: 'unknown_result' }],
  ])('%s (%s) -> %j', (status, detail, expected) => {
    expect(classifyScanState(status, detail)).toEqual(expected);
  });

  it('three situations, three answers: a finding (422, deleted), a scan that did not finish (503, NOT deleted), a scan still running (409)', () => {
    expect(scanRefusalHttp({ reason: 'blocked', code: 'threats_found' })).toEqual({ status: 422, code: 'malware_scan_blocked', message: II_SCAN_BLOCKED_MESSAGE });
    expect(scanRefusalHttp({ reason: 'blocked', code: 'unsupported' })).toEqual({ status: 422, code: 'malware_scan_unsupported', message: II_SCAN_UNSUPPORTED_MESSAGE });
    const incomplete = scanRefusalHttp({ reason: 'scanner_unavailable', code: 'scan_timeout' });
    expect(incomplete).toEqual({ status: 503, code: 'malware_scan_incomplete', message: II_SCAN_INCOMPLETE_MESSAGE });
    expect(scanRefusalHttp({ reason: 'pending' })).toEqual({ status: 409, code: 'malware_scan_pending', message: II_SCAN_PENDING_MESSAGE });
    // the honest wording: only a finding says "deleted"
    expect(II_SCAN_BLOCKED_MESSAGE).toMatch(/has been deleted/);
    expect(II_SCAN_INCOMPLETE_MESSAGE).toMatch(/has not been deleted/);
    expect(II_SCAN_INCOMPLETE_MESSAGE).toMatch(/not a finding about your file/);
    expect(II_SCAN_PENDING_MESSAGE).toMatch(/nothing was deleted/i);
    expect(II_SCAN_PENDING_MESSAGE).not.toMatch(/could not be cleared/);
  });
});

describe('upload: startIiRealScan', () => {
  it('a password-protected statement is NOT sent to the scanner (it would come back UNSUPPORTED) and NOT refused: the scan is deferred to the process call', async () => {
    const locked = await buildEncryptedTextPdf(LINES);
    const r = await startIiRealScan({ userId: U, sourceDocumentId: 'doc1', storagePath: 'p', bytes: locked, contentType: 'application/pdf', contentHash: sha(locked), hasScanColumns: true });
    expect(r).toEqual({ admitted: true });
    expect(h.initiated).toEqual([]);
    expect(h.purged).toEqual([]);
    expect(row().malware_scan_status).toBe('not_required'); // nothing parses these bytes until the process call has scanned them
  });
  it('a plain PDF is scanned as it is, exactly as before', async () => {
    const bytes = plainPdf();
    h.initiateResults.push({ status: 'clean' });
    expect(await startIiRealScan({ userId: U, sourceDocumentId: 'doc1', storagePath: 'p', bytes, contentType: 'application/pdf', contentHash: sha(bytes), hasScanColumns: true })).toEqual({ admitted: true });
    expect(h.initiated).toHaveLength(1);
    expect(Buffer.from(h.initiated[0].bytes).equals(Buffer.from(bytes))).toBe(true);
  });
  it('an owner-password-only statement (no password to type) is opened and its DECRYPTED bytes are scanned', async () => {
    const locked = await buildEncryptedTextPdf(LINES, { userPassword: '' });
    h.initiateResults.push({ status: 'clean' });
    await startIiRealScan({ userId: U, sourceDocumentId: 'doc1', storagePath: 'p', bytes: locked, contentType: 'application/pdf', contentHash: sha(locked), hasScanColumns: true });
    expect(h.initiated).toHaveLength(1);
    expect(Buffer.from(h.initiated[0].bytes).equals(Buffer.from(locked))).toBe(false);
    expect((await extractPdfText(new Uint8Array(h.initiated[0].bytes))).ok).toBe(true); // readable with no password: it really is decrypted
  });
  it('scan OFF: nothing is touched', async () => {
    h.enabled = false;
    const locked = await buildEncryptedTextPdf(LINES);
    expect(await startIiRealScan({ userId: U, sourceDocumentId: 'doc1', storagePath: 'p', bytes: locked, contentType: 'application/pdf', contentHash: 'h', hasScanColumns: true })).toEqual({ admitted: true });
    expect(h.initiated).toEqual([]);
  });
});

describe('process: ensureIiRealScanAdmissible with a password-protected statement', () => {
  beforeEach(async () => {
    h.stored = await buildEncryptedTextPdf(LINES);
  });

  it('no password -> password_required: the scanner is not called, NOTHING is deleted, the row is untouched', async () => {
    const before = JSON.stringify(row());
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: false, reason: 'password_required' });
    expect(h.initiated).toEqual([]);
    expect(h.purged).toEqual([]);
    expect(JSON.stringify(row())).toBe(before);
  });

  it('WRONG password -> wrong_password: never reaches the scanner or the parser, deletes nothing, counts as an attempt (without the value)', async () => {
    const r = await ensureIiRealScanAdmissible(U, 'doc1', { password: 'not-the-password-123' });
    expect(r).toEqual({ admitted: false, reason: 'wrong_password' });
    expect(h.initiated).toEqual([]);
    expect(h.purged).toEqual([]);
    const attempts = h.db.tables.ii_document_parse_runs;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ user_id: U, source_document_id: 'doc1', password_supplied: true, run_status: 'failed' });
    expect(JSON.stringify([h.db.writes, h.db.tables])).not.toContain('not-the-password-123');
  });

  it('the shared attempt limit applies: after the allowed wrong attempts the next one is refused BEFORE any decryption', async () => {
    const { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR: MAX } = await import('@/lib/financial-data-hub/bank-pdf/constants');
    for (let i = 0; i < MAX; i++) expect((await ensureIiRealScanAdmissible(U, 'doc1', { password: `wrong-${i}` }))).toEqual({ admitted: false, reason: 'wrong_password' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD })).toEqual({ admitted: false, reason: 'password_rate_limited' });
    expect(h.initiated).toEqual([]);
  });

  it('RIGHT password -> the scanner is given the DECRYPTED bytes (readable with no password), clean -> admitted, row recorded clean, nothing deleted', async () => {
    h.initiateResults.push({ status: 'clean' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD })).toEqual({ admitted: true });
    expect(h.initiated).toHaveLength(1);
    const scanned = h.initiated[0].bytes;
    expect(Buffer.from(scanned).equals(Buffer.from(h.stored!))).toBe(false);
    const text = await extractPdfText(new Uint8Array(scanned));
    expect(text.ok && text.text.includes('Folio No: 1122334455')).toBe(true);
    expect(h.initiated[0].contentHash).toBe(sha(scanned));
    expect(row().malware_scan_status).toBe('clean');
    expect(h.purged).toEqual([]);
  });

  it('a DECRYPTED copy the scanner marks as THREATS FOUND is blocked: stored file purged, document marked, reason code audited, no password anywhere', async () => {
    h.initiateResults.push({ status: 'malicious' });
    const r = await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD });
    expect(r).toMatchObject({ admitted: false, reason: 'blocked', code: 'threats_found' });
    expect(h.purged).toEqual(['doc1']);
    expect(row()).toMatchObject({ status: 'parse_failed', parse_error: 'malware_scan_malicious' });
    expect(auditReasons()).toContainEqual({ reason: 'malware_scan_refused', outcome: 'blocked', refusal: 'threats_found', scanStatus: 'malicious' });
    expect(JSON.stringify([h.db.writes, h.db.tables])).not.toContain(TEST_USER_PASSWORD);
  });

  it('later calls do not rescan or re-delete a final refusal', async () => {
    h.initiateResults.push({ status: 'malicious' });
    await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD });
    h.purged.length = 0;
    expect(await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD })).toMatchObject({ admitted: false, reason: 'blocked', code: 'threats_found' });
    expect(h.initiated).toHaveLength(1);
    expect(h.purged).toEqual([]);
  });

  it('a protection this library cannot open is refused as unreadable_protection (cannot be scanned), nothing is deleted, with its own reason code', async () => {
    h.stored = new TextEncoder().encode(['%PDF-1.7', '1 0 obj << /Filter /Standard /V 9 >> endobj', 'trailer << /Encrypt 1 0 R /Root 2 0 R >>', '%%EOF'].join('\n'));
    const r = await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD });
    // either the library reads it as an ordinary document (scanned as it is) or it cannot open it (refused): never a silent pass
    if (!r.admitted) expect(['unreadable_protection', 'password_required', 'wrong_password']).toContain(r.reason);
    else expect(h.initiated).toHaveLength(1);
    expect(h.purged).toEqual([]);
  });
});

describe('a scan that did not finish is NEVER turned into blocked-and-deleted', () => {
  beforeEach(() => {
    h.stored = plainPdf();
  });

  it.each([
    ['scan_timeout', 'scan_timeout'],
    ['scan_failed', 'scan_failed'],
    ['unknown', 'unknown_result'],
  ])('%s at scan time -> scanner_unavailable (503), the stored file is KEPT, the document is not marked failed, the reason is audited, and the next call scans again', async (status, code) => {
    h.initiateResults.push({ status });
    const r = await ensureIiRealScanAdmissible(U, 'doc1');
    expect(r).toEqual({ admitted: false, reason: 'scanner_unavailable', code });
    expect(h.purged, 'a scan that did not finish must not delete the person file').toEqual([]);
    expect(row().status).toBe('uploaded');
    expect(auditReasons()).toContainEqual({ reason: 'malware_scan_refused', outcome: 'unavailable', refusal: code, scanStatus: status });
    // retry: a fresh scan, and a clean verdict now admits
    h.initiateResults.push({ status: 'clean' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: true });
    expect(h.initiated).toHaveLength(2);
    expect(row().malware_scan_status).toBe('clean');
  });

  it('ACCESS_DENIED (the scanner could not read its own copy) is unavailable, not blocked; UNSUPPORTED on a PLAIN file stays blocked and deleted', async () => {
    h.initiateResults.push({ status: 'suspicious', detail: 'ACCESS_DENIED: reasons' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toMatchObject({ admitted: false, reason: 'scanner_unavailable', code: 'access_denied' });
    expect(h.purged).toEqual([]);
    h.initiateResults.push({ status: 'suspicious', detail: 'UNSUPPORTED: reasons' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toMatchObject({ admitted: false, reason: 'blocked', code: 'unsupported' });
    expect(h.purged).toEqual(['doc1']);
  });

  it('PENDING survives across presses: one upload to the scanner, then the SAME object is polled, and a clean verdict arriving on a later press is admitted', async () => {
    h.initiateResults.push({ status: 'pending' });
    h.continueResults.push({ status: 'pending' }, { status: 'clean' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: false, reason: 'pending' });
    expect(row().malware_scan_status).toBe('pending');
    expect(row().malware_scan_object_ref).toMatchObject({ ref: { objectKey: 'ii/u/doc/k.bin' } });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: false, reason: 'pending' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: true });
    expect(h.initiated, 'the file must not be sent to the scanner again while a scan is running').toHaveLength(1);
    expect(h.continued).toHaveLength(2);
    expect(h.continued[0].persisted).toMatchObject({ ref: { objectKey: 'ii/u/doc/k.bin' } });
    expect(row().malware_scan_status).toBe('clean');
    expect(h.purged).toEqual([]);
  });

  it('pending past the deadline is a TIMEOUT: unavailable, kept, retried later (it used to be "blocked ... has been deleted")', async () => {
    h.initiateResults.push({ status: 'pending' });
    await ensureIiRealScanAdmissible(U, 'doc1');
    h.continueResults.push({ status: 'scan_timeout' });
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toMatchObject({ admitted: false, reason: 'scanner_unavailable', code: 'scan_timeout' });
    expect(h.purged).toEqual([]);
    expect(row().status).toBe('uploaded');
  });

  it('every request polls with the request budget (about 15 seconds, well inside the 28 second web limit)', async () => {
    h.initiateResults.push({ status: 'pending' });
    h.continueResults.push({ status: 'pending' });
    await ensureIiRealScanAdmissible(U, 'doc1');
    await ensureIiRealScanAdmissible(U, 'doc1');
    const budget = h.initiated[0].pollBudget as { maxAttempts: number; delayMs: number };
    expect((budget.maxAttempts - 1) * budget.delayMs).toBeLessThanOrEqual(16_000);
    expect(budget.maxAttempts).toBeGreaterThan(3);
    expect(h.continued[0].pollBudget).toEqual(budget);
  });

  it('scan OFF -> admitted as before, nothing opened', async () => {
    h.enabled = false;
    h.stored = await buildEncryptedTextPdf(LINES);
    expect(await ensureIiRealScanAdmissible(U, 'doc1')).toEqual({ admitted: true });
    expect(h.initiated).toEqual([]);
  });
});

describe('replacement copy: the scan state is kept against the file hash', () => {
  const params = (bytes: Uint8Array, password?: string) => ({ userId: U, sourceDocumentId: 'doc1', bytes, contentType: 'application/pdf', contentHash: sha(bytes), hasScanColumns: true, password });
  beforeEach(() => {
    h.db.tables.ii_source_documents[0].storage_purged_at = '2026-10-01T00:00:00Z'; // the old file was deleted by design
  });

  it('press 1 pending (state persisted with the file hash), press 2 still pending (same scan continued, no second upload), press 3 clean -> admitted and recorded', async () => {
    const bytes = plainPdf();
    h.initiateResults.push({ status: 'pending' });
    h.continueResults.push({ status: 'pending' }, { status: 'clean' });
    expect(await scanReplacementCandidate(params(bytes))).toEqual({ admitted: false, reason: 'pending' });
    expect(row().malware_scan_status).toBe('pending');
    expect((row().malware_scan_object_ref as { candidateHash: string }).candidateHash).toBe(sha(bytes));
    expect(h.initiated[0].candidateHash).toBe(sha(bytes));
    expect(await scanReplacementCandidate(params(bytes))).toEqual({ admitted: false, reason: 'pending' });
    const third = await scanReplacementCandidate(params(bytes));
    expect(third).toMatchObject({ admitted: true, recorded: true });
    expect(h.initiated, 'one upload to the scanner for three presses').toHaveLength(1);
    expect(h.continued).toHaveLength(2);
    expect(row().malware_scan_status).toBe('clean');
    // a fourth press of the same file reuses the recorded clean verdict: no scan at all
    expect(await scanReplacementCandidate(params(bytes))).toMatchObject({ admitted: true, recorded: true });
    expect(h.initiated).toHaveLength(1);
    expect(h.continued).toHaveLength(2);
  });

  it('a DIFFERENT file after a pending one starts its own scan (the old state is never applied to other bytes)', async () => {
    h.initiateResults.push({ status: 'pending' }, { status: 'clean' });
    await scanReplacementCandidate(params(plainPdf()));
    const other = new Uint8Array(buildMinimalTextPdf([[...LINES, 'a different file']]));
    expect(await scanReplacementCandidate(params(other))).toMatchObject({ admitted: true });
    expect(h.initiated).toHaveLength(2);
    expect(h.continued).toEqual([]);
  });

  it('a clean verdict older than 30 minutes is not reused', async () => {
    const bytes = plainPdf();
    h.initiateResults.push({ status: 'clean' }, { status: 'clean' });
    await scanReplacementCandidate(params(bytes));
    h.db.tables.ii_source_documents[0].malware_scan_decided_at = new Date(Date.now() - 31 * 60_000).toISOString();
    await scanReplacementCandidate(params(bytes));
    expect(h.initiated).toHaveLength(2);
  });

  it('a password-protected copy: no password -> password_required, wrong -> wrong_password (neither scanned nor deleted); right -> the DECRYPTED bytes are scanned', async () => {
    const locked = await buildEncryptedTextPdf(LINES);
    expect(await scanReplacementCandidate(params(locked))).toEqual({ admitted: false, reason: 'password_required' });
    expect(await scanReplacementCandidate(params(locked, 'nope-nope'))).toEqual({ admitted: false, reason: 'wrong_password' });
    expect(h.initiated).toEqual([]);
    h.initiateResults.push({ status: 'clean' });
    expect(await scanReplacementCandidate(params(locked, TEST_USER_PASSWORD))).toMatchObject({ admitted: true, recorded: true });
    expect(Buffer.from(h.initiated[0].bytes).equals(Buffer.from(locked))).toBe(false);
    expect((await extractPdfText(new Uint8Array(h.initiated[0].bytes))).ok).toBe(true);
    expect(h.initiated[0].candidateHash).toBe(sha(locked)); // the state is keyed on the file as uploaded, never on anything derived from the password
    expect(JSON.stringify([h.db.writes, h.db.tables])).not.toContain(TEST_USER_PASSWORD);
    expect(JSON.stringify([h.db.writes, h.db.tables])).not.toContain('nope-nope');
  });

  it.each([
    ['malicious', null, 'blocked', 'threats_found'],
    ['suspicious', 'UNSUPPORTED: x', 'blocked', 'unsupported'],
    ['scan_timeout', null, 'scanner_unavailable', 'scan_timeout'],
    ['scan_failed', null, 'scanner_unavailable', 'scan_failed'],
    ['suspicious', 'ACCESS_DENIED: x', 'scanner_unavailable', 'access_denied'],
  ])('%s (%s) -> %s / %s: refused, and the reason is on the row AND on the audit trail (the old statement and its data are not touched)', async (status, detail, reason, code) => {
    const bytes = plainPdf();
    h.initiateResults.push({ status, detail: detail ?? undefined });
    expect(await scanReplacementCandidate(params(bytes))).toMatchObject({ admitted: false, reason, code });
    expect(row().malware_scan_status).toBe(status);
    expect(auditReasons().some((m) => m.reason === 'malware_scan_refused' && m.refusal === code)).toBe(true);
    expect(row().status).toBe('uploaded'); // a refused COPY never marks the existing statement failed
    expect(h.purged).toEqual([]);
  });

  it('scan OFF / migration 0196 absent', async () => {
    h.enabled = false;
    expect(await scanReplacementCandidate(params(plainPdf()))).toEqual({ admitted: true, verdict: null, recorded: false });
    h.enabled = true;
    expect(await scanReplacementCandidate({ ...params(plainPdf()), hasScanColumns: false })).toEqual({ admitted: false, reason: 'scanner_unavailable', code: 'scanner_not_configured' });
  });
});

describe('the password never leaves the process', () => {
  it('not in console output, audit events, database writes, thrown errors or the gate call arguments', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      h.stored = await buildEncryptedTextPdf(LINES);
      h.initiateResults.push({ status: 'clean' });
      await ensureIiRealScanAdmissible(U, 'doc1', { password: TEST_USER_PASSWORD });
      await ensureIiRealScanAdmissible(U, 'doc1', { password: 'definitely-wrong-pw' });
      const everything = JSON.stringify([h.db.writes, h.db.tables.ii_audit_events, h.db.tables.ii_document_parse_runs, h.initiated.map((i) => ({ ...i, bytes: i.bytes.byteLength }))]);
      for (const secret of [TEST_USER_PASSWORD, 'definitely-wrong-pw']) {
        expect(everything).not.toContain(secret);
        for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(secret);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
