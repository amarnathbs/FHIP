// Investment Intelligence — upload admission scan (2026-09-21 fix).
//
// Pure-function coverage for uploadAdmission.ts's scanUploadedPdfForAdmission,
// which closes M13A's finding that
// app/api/investment-intelligence/source-documents/route.ts had no
// magic-byte/structural check on its own upload surface. Mirrors the fixture
// style of tests/unit/aieFileValidation.test.ts (the module this reuses
// looksLikePdf/scanPdfStructure from) rather than re-deriving new synthetic
// PDF shapes.
import { describe, it, expect } from 'vitest';
import { scanUploadedPdfForAdmission, uploadAdmissionFailureMessage } from '@/lib/services/investment-intelligence/uploadAdmission';

function buildPdfBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF\n`);
}

describe('scanUploadedPdfForAdmission', () => {
  it('accepts a plausible, clean PDF', () => {
    const bytes = buildPdfBytes('1 0 obj << /Type /Catalog >> endobj');
    const result = scanUploadedPdfForAdmission(bytes);
    expect(result.ok).toBe(true);
  });

  it('rejects bytes that do not look like a PDF at all, as file_corrupt', () => {
    const bytes = new TextEncoder().encode('not a pdf at all');
    const result = scanUploadedPdfForAdmission(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('file_corrupt');
  });

  it('rejects embedded JavaScript structurally', () => {
    const bytes = buildPdfBytes('/Type /Action /S /JavaScript /JS (app.alert(1))');
    const result = scanUploadedPdfForAdmission(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('structural_reject');
      expect(result.reasons).toContain('embedded_javascript');
    }
  });

  it('rejects a /Launch action structurally', () => {
    const bytes = buildPdfBytes('/Type /Action /S /Launch /F (calc.exe)');
    const result = scanUploadedPdfForAdmission(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain('launch_action');
  });

  it('rejects polyglot-style trailing content after the last %%EOF marker', () => {
    const clean = buildPdfBytes('1 0 obj << >> endobj');
    const polyglot = new Uint8Array([...clean, ...new TextEncoder().encode('PK\x03\x04 hidden zip payload')]);
    const result = scanUploadedPdfForAdmission(polyglot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain('trailing_content_after_eof');
  });

  it('does not flag a clean PDF with normal trailing whitespace after %%EOF (no over-rejection)', () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nbody\n%%EOF\n\n');
    const result = scanUploadedPdfForAdmission(bytes);
    expect(result.ok).toBe(true);
  });

  it('uploadAdmissionFailureMessage never claims a real anti-malware scan ran', () => {
    expect(uploadAdmissionFailureMessage('structural_reject')).not.toMatch(/malware|virus|scanned by/i);
    expect(uploadAdmissionFailureMessage('file_corrupt')).not.toMatch(/malware|virus|scanned by/i);
  });
});
