/**
 * WP-08 (UPL-01, residual R-14-8): a PDF read has a wall-clock budget.
 *
 * `pdf-parse` is replaced here by a parser whose text extraction never
 * finishes -- the hang a hostile or disguised file can cause. The read must
 * stop within its budget, destroy the parser, and end as a retryable
 * `extraction_timeout` the user is told about in words -- on the bank-PDF
 * path end to end, the payslip mapping and the AIE local extractor.
 * (The last test reads a real text file disguised as a PDF with the REAL
 * parser: it fails fast as corrupt, well inside the budget.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, destroyed: 0, mode: 'hang' as 'hang' | 'real' }));

vi.mock('pdf-parse', async (importOriginal) => {
  const real = await importOriginal<typeof import('pdf-parse')>();
  class HangingPDFParse {
    private inner: InstanceType<typeof real.PDFParse> | null;
    constructor(opts: ConstructorParameters<typeof real.PDFParse>[0]) {
      this.inner = h.mode === 'real' ? new real.PDFParse(opts) : null;
    }
    getInfo() { return this.inner ? this.inner.getInfo() : Promise.resolve({ total: 1 }); }
    getText() { return this.inner ? this.inner.getText() : new Promise(() => undefined); }
    destroy() { h.destroyed += 1; return this.inner ? this.inner.destroy() : Promise.resolve(); }
  }
  return { ...real, PDFParse: HangingPDFParse };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient('a0000000-0000-4000-8000-00000000000a') }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({ downloadDocumentObject: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([37, 80, 68, 70]) })) }));
vi.mock('@/lib/financial-data-hub/services/identicalUpload', () => ({ findEarlierIdenticalUpload: vi.fn(async () => null), IDENTICAL_UPLOAD_SPECS: { bank: {} } }));

vi.setConfig({ testTimeout: 30000 });

const REPO = path.resolve(__dirname, '..', '..');
const A = 'a0000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  h.db = createFakeDb();
  h.destroyed = 0;
  h.mode = 'hang';
});

describe('bounded PDF text extraction', () => {
  it('bank-pdf extractPdfPages stops at its budget, destroys the parser and returns kind "timeout"', async () => {
    const { extractPdfPages } = await import('@/lib/financial-data-hub/bank-pdf/textExtraction');
    const started = Date.now();
    const result = await extractPdfPages(new Uint8Array([1, 2, 3]), undefined, { timeoutMs: 150 });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('timeout');
    expect(elapsed).toBeLessThan(2000);
    expect(h.destroyed).toBe(1);
  });

  it('the classifier and pipeline turn it into the retryable extraction_timeout status and error code', async () => {
    const { runBankPdfPipeline } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const { PDF_EXTRACTION_TIMEOUT_MS } = await import('@/lib/financial-data-hub/bank-pdf/constants');
    expect(PDF_EXTRACTION_TIMEOUT_MS).toBeLessThan(60_000); // below the process routes' maxDuration
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const pending = runBankPdfPipeline({ bytes: new Uint8Array([1]), statementUploadId: 'd', financialAccountId: 'a', currencyCode: 'AUD', dedupIndex: new Map() } as never);
      await vi.advanceTimersByTimeAsync(PDF_EXTRACTION_TIMEOUT_MS + 10);
      expect((await pending).status).toBe('extraction_timeout');
    } finally {
      vi.useRealTimers();
    }
    const { errorCodeForPdfExtractionFailure } = await import('@/lib/financial-data-hub/services/payslipProcessingService');
    expect(errorCodeForPdfExtractionFailure('timeout')).toBe('extraction_timeout');
  });

  it('END TO END: a hanging bank PDF leaves the document failed (retryable) with error_code extraction_timeout, and the panel says so in words', async () => {
    const DOC = 'd0000000-0000-4000-8000-0000000000c1';
    h.db.insert('fdh_statement_uploads', {
      id: DOC, user_id: A, household_id: null, financial_account_id: 'e0000000-0000-4000-8000-0000000000a1', source_type: 'pdf_native',
      currency_code: 'AUD', processing_status: 'queued', raw_document_storage_reference: 'x/y.pdf', malware_scan_status: 'clean',
      error_code: null, certification_status: null,
    });
    const constants = await import('@/lib/financial-data-hub/bank-pdf/constants');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { processBankPdfDocument } = await import('@/lib/financial-data-hub/services/bankPdfProcessingService');
      const pending = processBankPdfDocument(A, DOC);
      await vi.advanceTimersByTimeAsync(constants.PDF_EXTRACTION_TIMEOUT_MS + 10);
      const result = await pending;
      expect(result.pipelineStatus).toBe('extraction_timeout');
    } finally {
      vi.useRealTimers();
    }
    const doc = h.db.rows('fdh_statement_uploads').find((s) => s.id === DOC)!;
    expect(doc).toMatchObject({ processing_status: 'failed', error_code: 'extraction_timeout' });
    const panel = fs.readFileSync(path.join(REPO, 'components/expenses/BankStatementImportPanel.tsx'), 'utf8');
    expect(panel).toMatch(/extraction_timeout: 'Reading this file took too long/);
    for (const route of ['app/api/financial-data-hub/bank-pdf/[documentId]/process/route.ts', 'app/api/financial-data-hub/bank-csv/[documentId]/process/route.ts']) {
      expect(fs.readFileSync(path.join(REPO, route), 'utf8')).toMatch(/export const maxDuration = 60;/);
    }
  });

  it('the AIE local extractor has the same budget', async () => {
    const { extractPdfTextLocally } = await import('@/lib/aie/extraction/textExtraction');
    const result = await extractPdfTextLocally(new Uint8Array([1]), undefined, { timeoutMs: 100 });
    expect(!result.ok && result.kind).toBe('timeout');
    expect(h.destroyed).toBe(1);
  });

  it('a text file disguised as a PDF, read by the REAL parser, fails fast (well inside the budget) as corrupt', async () => {
    h.mode = 'real';
    const { extractPdfPages } = await import('@/lib/financial-data-hub/bank-pdf/textExtraction');
    const started = Date.now();
    const result = await extractPdfPages(new TextEncoder().encode('Date,Description,Amount\n01/08/2026,Groceries,-20.00\nThis is a text file renamed to .pdf\n'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('corrupt');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
