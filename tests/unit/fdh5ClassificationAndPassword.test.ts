/**
 * FDH-5 — PDF structural classification edge cases (corrupt, image-only,
 * page-limit) and password-protected PDF handling (spec sections 15-18,
 * 22-25, 81-82, 92).
 *
 * PASSWORD TEST METHODOLOGY (spec 92, "particular scrutiny area"). Same
 * documented, established precedent as
 * `tests/unit/iiR2PdfExtraction.test.ts`: genuinely encrypting a PDF's
 * content stream (RC4/AES per the PDF standard security handler) is out of
 * scope to hand-roll for a unit test — this suite verifies FDH-5's OWN
 * classification/routing logic against the real `PasswordException` TYPE
 * `pdf-parse` throws (via a controlled mock), not a full binary-level
 * encrypted-PDF round trip. See FDH5_PASSWORD_PROTECTED_PDF.md for the live
 * DEV artifact-absence proof this is paired with.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTruncatedPdf, buildEmptyTextPdf, buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildBankPdfFixture } from '../support/buildBankPdfFixture';
import { classifyPdf } from '@/lib/financial-data-hub/bank-pdf/classification';
import { checkPasswordAttemptRateLimit } from '@/lib/financial-data-hub/bank-pdf/password';
import { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR, PDF_MAX_PAGES } from '@/lib/financial-data-hub/bank-pdf/constants';

describe('FDH-5 PDF structural classification (spec 15)', () => {
  it('a corrupt/truncated PDF classifies as "corrupt", never fabricating a partial read', async () => {
    const result = await classifyPdf(new Uint8Array(buildTruncatedPdf()));
    expect(result.classification).toBe('corrupt');
    expect(result.pages).toBeNull();
  });

  it('a syntactically-valid PDF with no usable text classifies as "image_only" (simulates a scanned statement)', async () => {
    const result = await classifyPdf(new Uint8Array(buildEmptyTextPdf()));
    expect(result.classification).toBe('image_only');
  });

  it('a genuine text-native bank statement classifies as "text_native" and returns per-page text', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [{ date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' }],
      }),
    );
    const result = await classifyPdf(bytes);
    expect(result.classification).toBe('text_native');
    expect(result.pages).not.toBeNull();
    expect(result.pageCount).toBe(1);
  });

  it('a PDF whose page count exceeds PDF_MAX_PAGES is rejected as unsupported (page_limit_exceeded), never processed unbounded (spec 18, 81)', async () => {
    // A page beyond the certified limit — one line each is enough; the
    // ceiling check happens on page COUNT via getInfo(), before any text
    // extraction runs.
    const pages = Array.from({ length: PDF_MAX_PAGES + 1 }, (_, i) => [`Page ${i + 1}`]);
    const bytes = new Uint8Array(buildMinimalTextPdf(pages));
    const result = await classifyPdf(bytes);
    expect(result.classification).toBe('unsupported');
    expect(result.reasonCode).toBe('page_limit_exceeded');
  });
});

describe('FDH-5 password-protected PDF classification (spec 22-25, "particular scrutiny area")', () => {
  afterEach(() => {
    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('classifies as "encrypted" with reasonCode "password_required" when no password is supplied to an encrypted document', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class MockPDFParse {
        constructor() {}
        async getInfo(): Promise<never> {
          throw new actual.PasswordException('No password given');
        }
        async getText(): Promise<never> {
          throw new actual.PasswordException('No password given');
        }
        async destroy() {}
      }
      return { ...actual, PDFParse: MockPDFParse };
    });
    const { classifyPdf: mockedClassify } = await import('@/lib/financial-data-hub/bank-pdf/classification');
    const result = await mockedClassify(new Uint8Array([1, 2, 3]));
    expect(result.classification).toBe('encrypted');
    expect(result.reasonCode).toBe('password_required');
  });

  it('classifies as "encrypted" with reasonCode "wrong_password" when an INCORRECT password is supplied — and the error text never echoes the supplied password (spec 23, 84)', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class MockPDFParse {
        constructor() {}
        async getInfo(): Promise<never> {
          throw new actual.PasswordException('Incorrect Password');
        }
        async destroy() {}
      }
      return { ...actual, PDFParse: MockPDFParse };
    });
    const { classifyPdf: mockedClassify } = await import('@/lib/financial-data-hub/bank-pdf/classification');
    const suppliedPassword = 'super-secret-wrong-guess-XYZ789';
    const result = await mockedClassify(new Uint8Array([1, 2, 3]), suppliedPassword);
    expect(result.classification).toBe('encrypted');
    expect(result.reasonCode).toBe('wrong_password');
    // The password NEVER appears anywhere in the returned result object —
    // proven by serialising the whole result and searching for it.
    expect(JSON.stringify(result)).not.toContain(suppliedPassword);
  });

  it('a CORRECT password lets classification proceed to text_native, and the password never appears in the result', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class MockPDFParse {
        password?: string;
        constructor(opts: { password?: string }) {
          this.password = opts.password;
        }
        async getInfo() {
          return { total: 1 };
        }
        async getText() {
          return { pages: [{ num: 1, text: 'Commonwealth Bank of Australia Statement of Account\n1 Aug 2026 CARD PURCHASE A 45.20 DR 954.80'.repeat(2) }] };
        }
        async destroy() {}
      }
      return { ...actual, PDFParse: MockPDFParse };
    });
    const { classifyPdf: mockedClassify } = await import('@/lib/financial-data-hub/bank-pdf/classification');
    const correctPassword = 'the-real-password-999';
    const result = await mockedClassify(new Uint8Array([1, 2, 3]), correctPassword);
    expect(result.classification).toBe('text_native');
    expect(JSON.stringify(result)).not.toContain(correctPassword);
  });
});

describe('FDH-5 password rate limiting (spec 24)', () => {
  it('allows attempts under the configured ceiling', () => {
    const now = '2026-08-24T10:00:00.000Z';
    const events = Array.from({ length: MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR - 1 }, () => ({
      event_type: 'pdf_password_required',
      created_at: '2026-08-24T09:50:00.000Z',
    }));
    const result = checkPasswordAttemptRateLimit({ recentAuditEvents: events, nowIso: now });
    expect(result.allowed).toBe(true);
  });

  it('refuses a further attempt once the rolling-hour ceiling is reached — a real, enforced control, not a suggestion', () => {
    const now = '2026-08-24T10:00:00.000Z';
    const events = Array.from({ length: MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR }, () => ({
      event_type: 'pdf_password_required',
      created_at: '2026-08-24T09:50:00.000Z',
    }));
    const result = checkPasswordAttemptRateLimit({ recentAuditEvents: events, nowIso: now });
    expect(result.allowed).toBe(false);
  });

  it('does NOT count attempts from over an hour ago — a stale attempt never contributes to the ceiling', () => {
    const now = '2026-08-24T10:00:00.000Z';
    const events = Array.from({ length: MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR + 5 }, () => ({
      event_type: 'pdf_password_required',
      created_at: '2026-08-24T08:00:00.000Z', // 2 hours ago
    }));
    const result = checkPasswordAttemptRateLimit({ recentAuditEvents: events, nowIso: now });
    expect(result.allowed).toBe(true);
    expect(result.attemptsInWindow).toBe(0);
  });

  it('ignores unrelated event types entirely — only pdf_password_required counts', () => {
    const now = '2026-08-24T10:00:00.000Z';
    const events = Array.from({ length: 50 }, () => ({ event_type: 'document_validated', created_at: '2026-08-24T09:55:00.000Z' }));
    const result = checkPasswordAttemptRateLimit({ recentAuditEvents: events, nowIso: now });
    expect(result.allowed).toBe(true);
    expect(result.attemptsInWindow).toBe(0);
  });
});

describe('FDH-5 code-level password non-persistence audit (spec 23, "particular scrutiny area")', () => {
  it('no source file under lib/financial-data-hub/bank-pdf or the PDF services ever assigns a `password`-named value into an object literal destined for .insert()/.update(), or into recordDocumentAuditEvent metadata', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const roots = [
      path.resolve(__dirname, '../../lib/financial-data-hub/bank-pdf'),
      path.resolve(__dirname, '../../lib/financial-data-hub/services/bankPdfProcessingService.ts'),
      path.resolve(__dirname, '../../lib/financial-data-hub/services/bankPdfUploadService.ts'),
      path.resolve(__dirname, '../../app/api/financial-data-hub/bank-pdf'),
    ];
    const files: string[] = [];
    const walk = (p: string) => {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
      } else if (p.endsWith('.ts')) {
        files.push(p);
      }
    };
    for (const r of roots) walk(r);
    expect(files.length).toBeGreaterThan(0);

    // A password value must never appear as a VALUE inside an object
    // literal that is itself passed to .insert(/.update(/metadata:. This is
    // a coarse but effective static guard: the token "password" appearing
    // as an object-literal KEY anywhere near .insert(/.update( calls, OR
    // inside a `metadata:` object, is exactly the shape a real leak would
    // take.
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // No metadata object anywhere in these files may contain the literal
      // key "password".
      const metadataBlocks = [...src.matchAll(/metadata:\s*\{[^}]*\}/g)].map((m) => m[0]);
      for (const block of metadataBlocks) {
        expect(block, `${file}: password-shaped key found inside a metadata object`).not.toMatch(/\bpassword\b\s*:/i);
      }
      // No .insert(/.update( payload object anywhere in these files may
      // contain a bare `password` key either.
      const writeBlocks = [...src.matchAll(/\.(insert|update)\(\s*\{[^}]*\}/g)].map((m) => m[0]);
      for (const block of writeBlocks) {
        expect(block, `${file}: password-shaped key found inside an insert/update payload`).not.toMatch(/\bpassword\b\s*:/i);
      }
    }
  });
});
