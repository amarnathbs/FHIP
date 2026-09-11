import { describe, it, expect } from 'vitest';
import {
  looksLikePdf,
  scanPdfStructure,
  sha256Hex,
  validateUploadForAdmission,
  DEFAULT_AIE_UPLOAD_LIMITS,
  isPdfLikelyPasswordProtected,
} from '@/lib/aie/validation/fileValidation';

function buildPdfBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF\n`);
}

describe('AIE-1.1 admission validation (UPL/QUA)', () => {
  it('accepts a plausible PDF with no adversarial markers', () => {
    const bytes = buildPdfBytes('1 0 obj << /Type /Catalog >> endobj');
    const result = validateUploadForAdmission({
      declaredMimeType: 'application/pdf',
      byteLength: bytes.byteLength,
      bytes,
      allowMissingSignatureScanner: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detectedMimeType).toBe('application/pdf');
      expect(result.passwordRequired).toBe(false);
      expect(result.fileHash).toBe(sha256Hex(bytes));
    }
  });

  it('rejects non-PDF bytes declared as application/pdf as file_corrupt (no plausible type detected)', () => {
    const bytes = new TextEncoder().encode('not a pdf at all');
    const result = validateUploadForAdmission({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes, allowMissingSignatureScanner: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('file_corrupt');
  });

  it('rejects an unsupported declared MIME type outright', () => {
    const bytes = buildPdfBytes('x');
    const result = validateUploadForAdmission({ declaredMimeType: 'application/zip', byteLength: bytes.byteLength, bytes, allowMissingSignatureScanner: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('unsupported_file_type');
  });

  it('rejects a file over the configured size limit', () => {
    const bytes = buildPdfBytes('x');
    const result = validateUploadForAdmission({
      declaredMimeType: 'application/pdf',
      byteLength: bytes.byteLength,
      bytes,
      limits: { ...DEFAULT_AIE_UPLOAD_LIMITS, maxBytesByMimeType: { 'application/pdf': 4 } },
      allowMissingSignatureScanner: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('file_too_large');
  });

  it('fails closed when no signature scanner is configured and the caller does not opt into the DEV override', () => {
    const bytes = buildPdfBytes('x');
    const result = validateUploadForAdmission({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('malware_scan_failed_closed');
  });

  it('detects embedded JavaScript and rejects structurally (QUA-03)', () => {
    const bytes = buildPdfBytes('/Type /Action /S /JavaScript /JS (app.alert(1))');
    const result = validateUploadForAdmission({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes, allowMissingSignatureScanner: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('structural_reject');
  });

  it('detects a /Launch action and rejects structurally', () => {
    const bytes = buildPdfBytes('/Type /Action /S /Launch /F (calc.exe)');
    const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
    expect(scan.suspicious).toBe(true);
    expect(scan.reasons).toContain('launch_action');
  });

  it('detects polyglot-style trailing content after the last %%EOF marker (QUA-05)', () => {
    const clean = buildPdfBytes('1 0 obj << >> endobj');
    const polyglot = new Uint8Array([...clean, ...new TextEncoder().encode('PK\x03\x04 hidden zip payload')]);
    const cleanScan = scanPdfStructure(clean, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
    const polyglotScan = scanPdfStructure(polyglot, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
    expect(cleanScan.hasTrailingContentAfterEof).toBe(false);
    expect(polyglotScan.hasTrailingContentAfterEof).toBe(true);
    expect(polyglotScan.suspicious).toBe(true);
  });

  it('does not flag a clean PDF with normal trailing whitespace/newlines after %%EOF', () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nbody\n%%EOF\n\n');
    const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
    expect(scan.hasTrailingContentAfterEof).toBe(false);
  });

  it('detects a password-protected PDF via the /Encrypt token', () => {
    const bytes = buildPdfBytes('trailer << /Encrypt 5 0 R >>');
    expect(isPdfLikelyPasswordProtected(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes)).toBe(true);
  });

  it('looksLikePdf is false for too-short input', () => {
    expect(looksLikePdf(new Uint8Array([1, 2]))).toBe(false);
  });
});
