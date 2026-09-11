import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
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

// Builds a real PDF stream object: a dictionary declaring /FlateDecode
// followed by the actual deflate-compressed bytes of `content`, formatted
// the way a real PDF writer would (dictionary, `stream`, CRLF, raw
// compressed bytes, `endstream`).
function buildFlateDecodeStreamPdf(content: string): Uint8Array {
  const compressed = deflateSync(Buffer.from(content, 'ascii'));
  const header = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\r\n`, 'ascii');
  const footer = Buffer.from('\r\nendstream\nendobj\n%%EOF\n', 'ascii');
  return new Uint8Array(Buffer.concat([header, compressed, footer]));
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

  // AIE-1.6 certification finding (AIE_1_6_CERTIFICATION_REPORT.md section 5,
  // aie16CertificationAdversarialPdf.test.ts): a /JavaScript action hidden
  // inside a /FlateDecode-compressed stream evaded scanPdfStructure entirely
  // and passed full admission. This reproduces that EXACT scenario against
  // the fix, not a simplified stand-in — must now be caught.
  describe('FlateDecode-compressed stream detection (AIE-1.6 certification fix)', () => {
    it('THE DEFECT THIS FIX CLOSES: a /JavaScript action deflate-compressed inside a stream object is now detected', () => {
      const bytes = buildFlateDecodeStreamPdf('/Type /Action /S /JavaScript /JS (app.alert(1))');
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(true);
      expect(scan.reasons).toContain('embedded_javascript');
    });

    it('the same hostile bytes are rejected end-to-end at admission, not just flagged by the scan function in isolation', () => {
      const bytes = buildFlateDecodeStreamPdf('/Type /Action /S /JavaScript /JS (app.alert(1))');
      const result = validateUploadForAdmission({
        declaredMimeType: 'application/pdf',
        byteLength: bytes.byteLength,
        bytes,
        allowMissingSignatureScanner: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureCode).toBe('structural_reject');
    });

    it('a compressed /Launch action is also detected (not just /JavaScript)', () => {
      const bytes = buildFlateDecodeStreamPdf('/Type /Action /S /Launch /F (calc.exe)');
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(true);
      expect(scan.reasons).toContain('launch_action');
    });

    it('a genuinely clean FlateDecode stream (no disallowed tokens inside) is NOT flagged — proves this is not a blanket "reject all compressed streams" overcorrection', () => {
      const bytes = buildFlateDecodeStreamPdf('1 0 obj << /Type /Catalog >> endobj');
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(false);
    });

    it('a stream whose dictionary does NOT declare /FlateDecode is never passed to inflate, even if it happens to contain zlib-looking bytes', () => {
      // Deliberately mislabel: no /FlateDecode in the dictionary at all.
      const compressed = deflateSync(Buffer.from('/JavaScript', 'ascii'));
      const bytes = new Uint8Array(
        Buffer.concat([
          Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} >>\nstream\r\n`, 'ascii'),
          compressed,
          Buffer.from('\r\nendstream\nendobj\n%%EOF\n', 'ascii'),
        ])
      );
      // The raw compressed bytes themselves don't happen to contain the
      // literal ASCII token (that's the whole point of compression), so an
      // un-decompressed stream correctly reads as clean.
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(false);
    });

    it('malformed/non-zlib bytes inside a declared /FlateDecode stream do not throw and are not flagged (heuristic, not a guarantee — matches the module\'s own disclosed limits)', () => {
      const header = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 9 /Filter /FlateDecode >>\nstream\r\n', 'ascii');
      const garbage = Buffer.from('not-zlib!', 'ascii');
      const footer = Buffer.from('\r\nendstream\nendobj\n%%EOF\n', 'ascii');
      const bytes = new Uint8Array(Buffer.concat([header, garbage, footer]));
      expect(() => scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes)).not.toThrow();
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(false);
    });

    it('a stream that would decompress past the 20MB total budget is flagged as oversized rather than silently skipped or hung on (decompression-bomb guard)', () => {
      // A classic zip-bomb shape: a long run of one repeated byte
      // compresses to almost nothing but decompresses to something huge.
      // 25MB of zeros deflates to a few KB, deliberately exceeding the
      // real production 20MB total-decompressed-bytes budget.
      const bombPayload = Buffer.alloc(25 * 1024 * 1024, 0);
      const compressed = deflateSync(bombPayload);
      const header = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\r\n`, 'ascii');
      const footer = Buffer.from('\r\nendstream\nendobj\n%%EOF\n', 'ascii');
      const bytes = new Uint8Array(Buffer.concat([header, compressed, footer]));
      const scan = scanPdfStructure(bytes, DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes);
      expect(scan.suspicious).toBe(true);
      expect(scan.reasons).toContain('oversized_compressed_stream');
    });
  });
});
