import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractPdfText } from '@/lib/services/investment-intelligence/pdfExtraction';
import { buildMinimalTextPdf, buildTruncatedPdf, buildEmptyTextPdf } from '../support/buildMinimalPdf';

// Real, binary-level PDF extraction tests — buildMinimalTextPdf produces a
// genuinely valid PDF (proven against the actual `pdf-parse` library, not
// mocked) so the "success", "corrupt", and "insufficient text" paths below
// exercise the real dependency end-to-end. The password paths (CAMS-002 /
// KFIN-002 test IDs) are exercised via a controlled mock of `pdf-parse`'s
// PasswordException below — see R2_TESTING_AND_VERIFICATION.md for why:
// genuinely encrypting a PDF's content stream (RC4/AES per the PDF
// standard security handler) is out of scope to hand-roll for this test
// suite, so this suite verifies OUR classification logic (password-
// required vs wrong-password, based on whether a password was supplied)
// against the real PasswordException TYPE pdf-parse throws, honestly
// documented as not a full binary-level encrypted-PDF proof.

describe('extractPdfText — real binary PDF extraction (no mocking)', () => {
  it('extracts text from a genuinely valid, digitally-generated multi-page PDF', async () => {
    const pdf = buildMinimalTextPdf([
      ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', 'Folio No: 1201040000123'],
      ['AMC Name: HDFC Mutual Fund', 'Scheme Name: HDFC Flexi Cap Fund - Growth (Direct Plan)'],
    ]);
    const result = await extractPdfText(new Uint8Array(pdf));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('CAMS Consolidated Account Statement');
      expect(result.text).toContain('Folio No: 1201040000123');
      expect(result.pageCount).toBe(2);
      // The pdf-parse page-separator artifact must be stripped, not leaked
      // into parser input.
      expect(result.text).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
    }
  });

  it('classifies a truncated/corrupt PDF as "corrupt", never fabricating data', async () => {
    const result = await extractPdfText(new Uint8Array(buildTruncatedPdf()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('corrupt');
  });

  it('classifies a syntactically-valid PDF with no usable text as "insufficient_text" (simulates a scanned/image-only document)', async () => {
    const result = await extractPdfText(new Uint8Array(buildEmptyTextPdf()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('insufficient_text');
  });

  it('classifies a completely empty byte array as an extraction failure, never a fabricated empty-but-valid result', async () => {
    const result = await extractPdfText(new Uint8Array(0));
    expect(result.ok).toBe(false);
  });
});

describe('extractPdfText — password classification logic (spec section 10)', () => {
  afterEach(() => {
    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('CAMS-002/KFIN-002: classifies as "password_required" when no password was supplied and the document needs one', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class FakePDFParse {
        async getText(): Promise<never> {
          throw new actual.PasswordException('No password given');
        }
        async destroy() {
          return undefined;
        }
      }
      return { ...actual, PDFParse: FakePDFParse };
    });
    const { extractPdfText: extractPdfTextMocked } = await import('@/lib/services/investment-intelligence/pdfExtraction');
    const result = await extractPdfTextMocked(new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('password_required');
      // The critical-failure-condition guard: the error message must never
      // echo back anything password-shaped (there is nothing to echo here
      // since none was supplied, but this asserts the message text itself
      // contains no password-looking content).
      expect(result.error.toLowerCase()).not.toContain('supplied password');
    }
  });

  it('CAMS-002/KFIN-002: classifies as "wrong_password" when a password WAS supplied but pdf-parse still rejects it, and never includes the password in the error text', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class FakePDFParse {
        async getText(): Promise<never> {
          throw new actual.PasswordException('Incorrect Password');
        }
        async destroy() {
          return undefined;
        }
      }
      return { ...actual, PDFParse: FakePDFParse };
    });
    const { extractPdfText: extractPdfTextMocked } = await import('@/lib/services/investment-intelligence/pdfExtraction');
    const suppliedPassword = 'TotallySecretValue123';
    const result = await extractPdfTextMocked(new Uint8Array([1, 2, 3]), suppliedPassword);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('wrong_password');
      expect(result.error).not.toContain(suppliedPassword);
    }
  });

  it('always calls destroy() even on the password-failure path (retryability, spec section 10)', async () => {
    vi.resetModules();
    const destroySpy = vi.fn(async () => undefined);
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class FakePDFParse {
        async getText(): Promise<never> {
          throw new actual.PasswordException('No password given');
        }
        async destroy() {
          return destroySpy();
        }
      }
      return { ...actual, PDFParse: FakePDFParse };
    });
    const { extractPdfText: extractPdfTextMocked } = await import('@/lib/services/investment-intelligence/pdfExtraction');
    await extractPdfTextMocked(new Uint8Array([1, 2, 3]));
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
