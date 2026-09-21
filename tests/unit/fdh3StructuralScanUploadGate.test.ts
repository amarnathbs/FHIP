/**
 * FDH-3 malware-scan-gap remediation (2026-09-21) — proves the shared
 * structural PDF scan (`lib/shared/pdfStructuralScan.ts`, extracted from the
 * AIE document-extraction pipeline) is actually wired into FDH-3's upload
 * path, runs BEFORE any file is written to storage or handed off for
 * parsing/OCR, and does not regress a legitimate upload.
 *
 * WHY ONE TEST FILE COVERS EVERY FDH-3 UPLOAD ROUTE. Every FDH-3 document
 * type (bank-csv, bank-pdf, payslip, liability/investment/retirement
 * statement) funnels through the SAME single choke point:
 * `completeUpload()` in `lib/financial-data-hub/services/uploadLifecycle.ts`,
 * which calls `validateUploadedFile()` (domain/fileValidation.ts) before
 * ever calling `uploadDocumentObject()` (the storage write) or
 * `ingestionJobsRepository.create()` (the handoff to a future parser/OCR
 * worker — see `uploadLifecycle.ts`'s own "Processing-QUEUE HANDOFF"
 * comment). Confirmed by direct inspection of every upload
 * route/service in `app/api/financial-data-hub/**` and
 * `lib/financial-data-hub/services/*UploadService.ts` /
 * `*StatementProcessingService.ts` — bank-csv and bank-pdf call it via
 * `bankCsvUploadService.ts`/`bankPdfUploadService.ts`; payslip, liability,
 * investment and retirement statements call it via the generic
 * `documents/upload-sessions/[sessionId]/complete` route or their own
 * `*StatementProcessingService.ts`, all of which import `completeUpload`
 * from this exact module. Proving the gate here proves it for all six.
 *
 * HONEST SCOPE (see `lib/shared/pdfStructuralScan.ts`'s own header): this is
 * a structural/heuristic scan for a specific, disclosed bypass class
 * (embedded JavaScript/launch actions, including inside a `/FlateDecode`
 * stream, plus polyglot trailing content) — NOT a real signature-based or
 * behavioural malware scanner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deflateSync } from 'node:zlib';

const mocks = vi.hoisted(() => ({
  sessionGetForUser: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionCreate: vi.fn(),
  sessionListForUser: vi.fn(),
  documentGetForUser: vi.fn(),
  documentUpdate: vi.fn(),
  documentCreate: vi.fn(),
  documentListForUser: vi.fn(),
  ingestionJobCreate: vi.fn(),
  recordDocumentAuditEvent: vi.fn(),
  uploadDocumentObject: vi.fn(),
  verifyDocumentObjectExists: vi.fn(),
}));

vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    getForUser: mocks.documentGetForUser,
    update: mocks.documentUpdate,
    create: mocks.documentCreate,
    listForUser: mocks.documentListForUser,
  },
  uploadSessionsRepository: {
    getForUser: mocks.sessionGetForUser,
    update: mocks.sessionUpdate,
    create: mocks.sessionCreate,
    listForUser: mocks.sessionListForUser,
  },
  ingestionJobsRepository: {
    create: mocks.ingestionJobCreate,
  },
}));

vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: mocks.recordDocumentAuditEvent,
}));

vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  uploadDocumentObject: mocks.uploadDocumentObject,
  verifyDocumentObjectExists: mocks.verifyDocumentObjectExists,
  createDocumentPreviewUrl: vi.fn(),
  deleteDocumentObject: vi.fn(),
  verifyDocumentObjectAbsent: vi.fn(),
}));

import { completeUpload } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { validateUploadedFile } from '@/lib/financial-data-hub/domain/fileValidation';

const USER_ID = 'fdh3-structural-scan-user';
const DOCUMENT_ID = 'doc-1';
const SESSION_ID = 'session-1';

// Builds a real PDF stream object exactly like
// tests/unit/aie16CertificationAdversarialPdf.test.ts's own hostile fixture
// — the exact adversarial case the AIE-1.6 certification pass constructed
// and proved evaded the pre-fix literal-only scan: a `/JavaScript` action
// deflate-compressed inside a `/Filter /FlateDecode` stream, so the literal
// ASCII text "/JavaScript" never appears anywhere in the file's raw bytes.
function buildHostileFlateDecodePdf(): Uint8Array {
  const hostilePayload = Buffer.from('<< /S /JavaScript /JS (app.alert(document.cookie)) >>', 'ascii');
  const compressed = deflateSync(hostilePayload);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'ascii'),
      Buffer.from(`1 0 obj << /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, 'ascii'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'ascii'),
    ]),
  );
}

const CLEAN_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  'ascii',
);

describe('FDH-3 domain layer — validateUploadedFile rejects the AIE-1.6 hostile fixture', () => {
  it('confirms the literal token is genuinely absent from the hostile fixture\'s raw bytes (sanity)', () => {
    const bytes = buildHostileFlateDecodePdf();
    expect(Buffer.from(bytes).includes(Buffer.from('/JavaScript', 'ascii'))).toBe(false);
  });

  it('rejects the FlateDecode-hidden /JavaScript PDF as structural_scan_rejected', () => {
    const bytes = buildHostileFlateDecodePdf();
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result).toEqual({ ok: false, failureCode: 'structural_scan_rejected' });
  });

  it('rejects a raw (uncompressed) /JavaScript token too', () => {
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >>\nendobj\n%%EOF\n', 'ascii');
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result).toEqual({ ok: false, failureCode: 'structural_scan_rejected' });
  });

  it('rejects polyglot-style trailing content after the last %%EOF marker', () => {
    const bytes = Buffer.concat([CLEAN_PDF, Buffer.from('PK\x03\x04 hidden zip payload', 'ascii')]);
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result).toEqual({ ok: false, failureCode: 'structural_scan_rejected' });
  });

  it('ZERO REGRESSION — a clean, legitimate PDF is still accepted unchanged', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: CLEAN_PDF.byteLength,
      bytes: CLEAN_PDF,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detectedMimeType).toBe('application/pdf');
      expect(result.passwordRequired).toBe(false);
    }
  });

  it('ZERO REGRESSION — a clean CSV is unaffected by the new PDF-only scan', () => {
    const bytes = Buffer.from('date,description,amount\n2026-01-01,Sample,10.00\n', 'utf8');
    const result = validateUploadedFile({ declaredMimeType: 'text/csv', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(true);
  });
});

describe('FDH-3 completeUpload() — the hostile fixture is rejected BEFORE storage write or parser/OCR handoff', () => {
  const liveSession = {
    id: SESSION_ID,
    document_id: DOCUMENT_ID,
    user_id: USER_ID,
    allowed_mime_type: 'application/pdf',
    expected_max_size_bytes: 20 * 1024 * 1024,
    storage_bucket: 'fdh-source-documents',
    storage_key: `${USER_ID}/${DOCUMENT_ID}/${DOCUMENT_ID}.bin`,
    upload_status: 'session_created',
    failure_code: null,
    created_at: '2026-01-01T00:00:00.000Z',
    // Far in the future relative to real wall-clock test execution time —
    // `assertSessionIsLive()` compares against `new Date()`, so a fixed
    // near-term timestamp would make this fixture spuriously "expired" long
    // after this file was written.
    expires_at: '2099-01-01T00:15:00.000Z',
    completed_at: null,
    expired_at: null,
  };
  const liveDocument = {
    id: DOCUMENT_ID,
    user_id: USER_ID,
    household_id: null,
    processing_status: 'created',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionGetForUser.mockResolvedValue({ data: liveSession, error: null });
    mocks.documentGetForUser.mockResolvedValue({ data: liveDocument, error: null });
    mocks.sessionUpdate.mockResolvedValue({ data: { ...liveSession }, error: null });
    mocks.documentUpdate.mockImplementation(async (_userId: string, _id: string, patch: Record<string, unknown>) => ({
      data: { ...liveDocument, ...patch },
      error: null,
    }));
    mocks.documentListForUser.mockResolvedValue({ data: [], error: null });
    mocks.uploadDocumentObject.mockResolvedValue({ ok: true });
    mocks.verifyDocumentObjectExists.mockResolvedValue({ exists: true, sizeBytes: 123 });
    mocks.ingestionJobCreate.mockResolvedValue({ data: {}, error: null });
    mocks.recordDocumentAuditEvent.mockResolvedValue(undefined);
  });

  it('THE DEFECT THIS FIX CLOSES: the malicious fixture never reaches storage or the parser/OCR queue (call count = 0)', async () => {
    const bytes = buildHostileFlateDecodePdf();

    const result = await completeUpload(USER_ID, SESSION_ID, bytes);

    // Rejected, not silently passed through.
    expect(result.processing_status).toBe('failed');
    expect((result as { error_code?: string }).error_code).toBe('structural_scan_rejected');

    // The two "must not be reachable" operations for a rejected file:
    // writing the bytes to storage, and queuing a parser/OCR job.
    expect(mocks.uploadDocumentObject).not.toHaveBeenCalled();
    expect(mocks.ingestionJobCreate).not.toHaveBeenCalled();

    // The rejection is audited (document_rejected, same generic event type
    // every other validateUploadedFile failure already uses), naming the
    // real reason — never silently dropped.
    expect(mocks.recordDocumentAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'document_rejected',
        metadata: expect.objectContaining({ reason: 'structural_scan_rejected' }),
      }),
    );
  });

  it('ZERO REGRESSION — a clean PDF still reaches storage and gets queued for processing', async () => {
    const result = await completeUpload(USER_ID, SESSION_ID, CLEAN_PDF);

    expect(result.processing_status).toBe('queued');
    expect(mocks.uploadDocumentObject).toHaveBeenCalledTimes(1);
    expect(mocks.ingestionJobCreate).toHaveBeenCalledTimes(1);
  });
});
