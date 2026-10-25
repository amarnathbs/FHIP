// Document2 (4) WP-B (F5/F6/F14) -- BEHAVIOURAL tests of the two server halves of the stale-evidence rule:
//   1. processSourceDocument refuses a file-dependent action up front when the raw file was (correctly) deleted -- no parse run, no
//      `parse_failed`, no "Could not retrieve the stored document" -- and still works when the file is stored (negative control);
//   2. replaceSourceDocumentFile attaches a controlled replacement copy to the SAME logical document: one row, same id and owner,
//      new file reference, lineage on the audit trail, the malware gate re-run, never a second document.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  downloads: [] as string[],
  uploads: [] as string[],
  removed: [] as string[],
  extractCalls: [] as (string | undefined)[],
  /** When set, the PDF text layer is this statement text (so the WP-H identity check can read the copy); null = a wrong-password failure, as before. */
  extractText: null as string | null,
  scanVerdict: { admitted: true } as { admitted: boolean; reason?: string },
  scanCalls: [] as { contentHash: string }[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  downloadSourceDocumentObject: async (key: string) => {
    h.downloads.push(key);
    return { bytes: Buffer.from('x'), error: null };
  },
  uploadSourceDocumentObject: async (key: string) => {
    h.uploads.push(key);
    return { error: null };
  },
  deleteSourceDocumentObject: async (key: string) => {
    h.removed.push(key);
    return { error: null };
  },
}));
vi.mock('@/lib/services/investment-intelligence/pdfExtraction', () => ({
  extractPdfText: async (_b: Uint8Array, password?: string) => {
    h.extractCalls.push(password);
    if (h.extractText) return { ok: true as const, text: h.extractText, pageCount: 1 };
    return { ok: false as const, kind: 'wrong_password' as const, error: 'wrong password' };
  },
}));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  // WP-H: the replacement flow scans the copy BEFORE reading it (scanReplacementCandidate) and records the verdict after attaching.
  scanReplacementCandidate: async (p: { contentHash: string }) => {
    h.scanCalls.push({ contentHash: p.contentHash });
    return h.scanVerdict.admitted ? { admitted: true as const, verdict: null } : { admitted: false as const, reason: h.scanVerdict.reason as 'pending' | 'blocked' | 'scanner_unavailable', code: h.scanVerdict.reason === 'scanner_unavailable' ? 'scanner_not_configured' : 'threats_found' };
  },
  recordAdmittedReplacementScan: async () => undefined,
  II_SCAN_BLOCKED_MESSAGE: 'blocked-message',
  II_SCAN_UNAVAILABLE_MESSAGE: 'unavailable-message',
}));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';
import { SOURCE_FILE_NOT_STORED_STATUS } from '@/lib/services/investment-intelligence/caseLifecycle';

const U = 'user-1';
const PDF = new Uint8Array(buildMinimalTextPdf([['Statement copy A']]));
const PDF_B = new Uint8Array(buildMinimalTextPdf([['Statement copy B']]));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function doc(over: Row = {}): Row {
  return {
    id: 'doc1',
    user_id: U,
    status: 'parsed',
    storage_path: 'user-1/old.pdf',
    storage_purged_at: '2026-10-01T00:00:00Z',
    storage_purge_error: null,
    checksum: 'oldchecksum0000',
    original_filename: 'ADXXXXXXX9Q_old.pdf',
    mime_type: 'application/pdf',
    file_size: 10,
    owner_member_id: 'member-1',
    country_code: 'IN',
    // WP-H: the structured provenance a processed statement RETAINS after its file is deleted (period 01-01-2025 to 31-03-2025, CAMS).
    source_detected: 'cams',
    document_type_detected: 'cas_statement',
    statement_period_start: '2025-01-01',
    statement_period_end: '2025-03-31',
    statement_as_of_date: '2025-03-31',
    malware_scan_status: 'clean',
    malware_scan_object_ref: null,
    malware_scan_admission_deadline_at: null,
    malware_scan_decided_at: null,
    ...over,
  };
}

function seed(documents: Row[], extra: Record<string, Row[]> = {}) {
  h.db.reset({ ii_source_documents: documents, ii_document_parse_runs: [], ii_audit_events: [], ii_reconciliation_cases: [], ...extra });
  h.downloads.length = 0;
  h.uploads.length = 0;
  h.removed.length = 0;
  h.extractCalls.length = 0;
  h.scanCalls.length = 0;
  h.scanVerdict = { admitted: true };
}

beforeEach(() => {
  h.extractText = null;
  h.db = createInMemoryDb();
  seed([doc()]);
});

describe('processSourceDocument when the raw file was deleted (F5: "Could not retrieve the stored document")', () => {
  it('REGRESSION: a parsed statement with a purged file answers source_file_not_stored, opens no parse run and keeps its status', async () => {
    // a prior SUCCEEDED run exists and forceReparse is the Reprocess button the PO clicked
    h.db.tables.ii_document_parse_runs.push({ id: 'run0', source_document_id: 'doc1', user_id: U, run_status: 'succeeded' });
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', password: 'secret', forceReparse: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(SOURCE_FILE_NOT_STORED_STATUS);
    expect(r.error).toMatch(/replacement copy/i);
    expect(r.error).not.toMatch(/Could not retrieve/);
    expect(h.db.tables.ii_document_parse_runs).toHaveLength(1); // no new run
    expect(h.db.tables.ii_source_documents[0].status).toBe('parsed'); // never rewritten to parse_failed
    expect(h.downloads).toEqual([]); // storage was never even asked
    expect(h.extractCalls).toEqual([]); // and the password was never used
  });

  it('a password-required statement whose file was purged is not marked failed either, and no password attempt is consumed', async () => {
    seed([doc({ status: 'password_required' })]);
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', password: 'secret' });
    expect(r.status).toBe(SOURCE_FILE_NOT_STORED_STATUS);
    expect(h.db.tables.ii_source_documents[0].status).toBe('password_required');
    expect(h.db.tables.ii_document_parse_runs).toHaveLength(0);
    expect(h.db.tables.ii_reconciliation_cases).toHaveLength(0);
  });

  it('the object missing although no purge was recorded: same truth, the run is closed, the status is NOT rewritten to parse_failed', async () => {
    seed([doc({ status: 'uploaded', storage_purged_at: null })]);
    const dl = await import('@/lib/services/investment-intelligence/storage');
    const spy = vi.spyOn(dl, 'downloadSourceDocumentObject').mockResolvedValueOnce({ bytes: null, error: 'Object not found' });
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1' });
    spy.mockRestore();
    expect(r.status).toBe(SOURCE_FILE_NOT_STORED_STATUS);
    expect(h.db.tables.ii_source_documents[0].status).toBe('uploaded');
  });

  it('NEGATIVE CONTROL: with the file stored the pipeline DOES read it and use the password (so the guard is not a blanket refusal)', async () => {
    seed([doc({ status: 'password_required', storage_purged_at: null })]);
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', password: 'secret' });
    expect(h.downloads).toEqual(['user-1/old.pdf']);
    expect(h.extractCalls).toEqual(['secret']);
    expect(r.status).not.toBe(SOURCE_FILE_NOT_STORED_STATUS);
  });

  it("another user's document is not found, never reported as 'file not stored'", async () => {
    seed([doc({ user_id: 'user-2' })]);
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1' });
    expect(r.status).toBe('not_found');
  });
});

describe('replaceSourceDocumentFile: a controlled replacement, not a duplicate (F14)', () => {
  // The copy is a CAMS statement for exactly the retained period, so the WP-H identity check passes and these tests stay about the mechanics.
  beforeEach(() => {
    h.extractText = buildAieIiCasFixtureText();
  });

  it('attaches the new copy to the SAME statement: same id and owner, no second row, file reference and checksum updated', async () => {
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'ADXXXXXXX9Q_new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r.ok).toBe(true);
    const rows = h.db.tables.ii_source_documents;
    expect(rows).toHaveLength(1); // never a second document
    expect(rows[0]).toMatchObject({
      id: 'doc1',
      owner_member_id: 'member-1', // the owner choice is untouched
      status: 'parsed', // holdings / transactions already written stay valid
      storage_purged_at: null,
      checksum: sha(PDF),
      original_filename: 'ADXXXXXXX9Q_new.pdf',
    });
    expect(String(rows[0].storage_path)).not.toBe('user-1/old.pdf');
    expect(h.uploads).toHaveLength(1);
    expect(rows[0].storage_path).toBe(h.uploads[0]);
  });

  it('records the lineage on the audit trail and re-runs the malware gate on the NEW bytes (the old verdict is reset)', async () => {
    await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    const event = h.db.tables.ii_audit_events.find((e) => e.event_type === 'upload');
    expect(event?.subject_id).toBe('doc1');
    expect(event?.metadata).toMatchObject({ controlledReplacement: true, replacementOf: 'doc1', previousFilename: 'ADXXXXXXX9Q_old.pdf', newFilename: 'new.pdf', checksumChanged: true });
    expect(h.scanCalls).toEqual([{ contentHash: sha(PDF) }]);
    expect(h.db.tables.ii_source_documents[0].malware_scan_status).toBe('not_required'); // reset: the 'clean' verdict was for the old file
  });

  it('a blocked scan is reported and not treated as success: nothing is parsed, stored or changed (WP-H: the verdict comes BEFORE the copy is read)', async () => {
    h.scanVerdict = { admitted: false, reason: 'blocked' };
    const before = JSON.stringify(h.db.tables.ii_source_documents[0]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 422, code: 'malware_scan_blocked' });
    expect(h.extractCalls, 'unscanned or blocked bytes are never parsed').toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(JSON.stringify(h.db.tables.ii_source_documents[0])).toBe(before);
  });

  it('a scan still pending asks the screen to wait (409 malware_scan_pending); nothing is parsed, stored or changed', async () => {
    h.scanVerdict = { admitted: false, reason: 'pending' };
    const before = JSON.stringify(h.db.tables.ii_source_documents[0]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 409, code: 'malware_scan_pending' });
    expect(h.extractCalls).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(JSON.stringify(h.db.tables.ii_source_documents[0])).toBe(before);
  });

  it('a scanner that is unavailable fails closed (503) and parses nothing', async () => {
    h.scanVerdict = { admitted: false, reason: 'scanner_unavailable' };
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 503, code: 'malware_scan_unavailable' });
    expect(h.extractCalls).toEqual([]);
  });

  it('REVIVES a discarded (archived) statement so the person can finish what they started', async () => {
    seed([doc({ status: 'archived' })]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r.ok).toBe(true);
    expect(h.db.tables.ii_source_documents[0].status).toBe('uploaded');
  });

  it('NEGATIVE CONTROL: refused while the original file is still stored (that is a duplicate, not a replacement); nothing is uploaded', async () => {
    seed([doc({ storage_purged_at: null })]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 409, code: 'replacement_not_allowed' });
    expect(h.uploads).toEqual([]);
    expect(h.db.tables.ii_source_documents[0].storage_path).toBe('user-1/old.pdf');
  });

  it('refuses a file that is already attached to a DIFFERENT statement of the person, and says which one', async () => {
    seed([doc(), doc({ id: 'doc2', checksum: sha(PDF), storage_purged_at: null })]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 409, code: 'file_belongs_to_another_statement', existingDocumentId: 'doc2' });
    expect(h.uploads).toEqual([]);
  });

  it('the SAME bytes as the original are fine (the person re-downloaded the identical file): checksum unchanged, still one row', async () => {
    seed([doc({ checksum: sha(PDF) })]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'again.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: true, checksumChanged: false });
    expect(h.db.tables.ii_source_documents).toHaveLength(1);
  });

  it("is per user: another user's statement is 404 and nothing is uploaded or changed", async () => {
    seed([doc({ user_id: 'user-2' })]);
    const r = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF });
    expect(r).toMatchObject({ ok: false, httpStatus: 404 });
    expect(h.uploads).toEqual([]);
    expect(h.db.tables.ii_source_documents[0].storage_path).toBe('user-1/old.pdf');
  });

  it('rejects a wrong file type and a PDF that fails the structural check, before anything is stored', async () => {
    const wrongType = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'x.exe', mimeType: 'application/octet-stream', bytes: PDF });
    expect(wrongType).toMatchObject({ ok: false, httpStatus: 422, code: 'invalid_file' });
    const notPdf = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(notPdf).toMatchObject({ ok: false, httpStatus: 422, code: 'upload_admission_rejected' });
    expect(h.uploads).toEqual([]);
  });

  it('END TO END (F14): replace, then reprocess -- the file is read again and the password is used on the SAME document', async () => {
    seed([doc({ status: 'password_required' })]);
    h.extractCalls.length = 0;
    const rep = await replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: PDF_B, password: 'secret' });
    expect(rep.ok).toBe(true);
    expect(h.extractCalls).toEqual(['secret']); // the identity check read the copy with the password
    h.extractText = null; // the processing run that follows stops at the password step, as before
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', password: 'secret' });
    expect(r.status).not.toBe(SOURCE_FILE_NOT_STORED_STATUS); // before the replacement this was the dead end
    expect(h.downloads).toEqual([h.uploads[0]]);
    expect(h.extractCalls).toEqual(['secret', 'secret']);
    expect(h.db.tables.ii_source_documents).toHaveLength(1);
  });
});
