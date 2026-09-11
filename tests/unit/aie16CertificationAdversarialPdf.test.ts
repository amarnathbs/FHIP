/**
 * AIE-1.6 independent certification — adversarial hostile-document probe
 * (not part of any AIE-1.x phase's own test suite). Confirms, by actually
 * constructing and scanning bytes (not just reading the source comment),
 * whether the disclosed limitation in `scanPdfStructure`'s own header
 * ("a sufficiently obfuscated/compressed object stream could hide the
 * literal token") is real and exploitable in this exact implementation.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { scanPdfStructure, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';

describe('AIE-1.6 certification — adversarial: FlateDecode-hidden /JavaScript token', () => {
  it('a raw, uncompressed /JavaScript token IS caught (sanity baseline)', () => {
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >>\nendobj\n%%EOF\n', 'ascii');
    const result = scanPdfStructure(bytes, 10 * 1024 * 1024);
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('embedded_javascript');
  });

  it('CONFIRMS the disclosed gap: the SAME /JavaScript token hidden inside a FlateDecode-compressed object stream is NOT caught by the literal-token scan', () => {
    const hostilePayload = Buffer.from('<< /S /JavaScript /JS (app.alert(document.cookie)) >>', 'ascii');
    const compressed = deflateSync(hostilePayload);

    // Build a minimal but plausible PDF where the malicious dictionary is
    // wrapped in a /Filter /FlateDecode stream — the literal ASCII text
    // "/JavaScript" never appears anywhere in the file's raw bytes.
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'ascii'),
      Buffer.from(`1 0 obj << /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`, 'ascii'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'ascii'),
    ]);

    expect(pdf.includes(Buffer.from('/JavaScript', 'ascii'))).toBe(false); // confirm the literal token is genuinely absent from raw bytes

    const result = scanPdfStructure(pdf, 10 * 1024 * 1024);
    // THIS IS THE CONFIRMED GAP: a real, executable-looking /JavaScript
    // action inside a compressed stream sails through `scanPdfStructure`
    // undetected, exactly as the function's own header discloses. Recorded
    // here as independently CONFIRMED (not just a code-comment claim) for
    // the AIE-1.6 certification report; it is unit-tested to REMAIN true
    // (i.e. this test documents current behaviour), not asserted as
    // acceptable.
    expect(result.suspicious).toBe(false);

    // End-to-end: the SAME hostile bytes pass full admission (given the
    // disclosed "no scanner configured" DEV override, matching how this
    // route is actually invoked in every AIE intake route today).
    const admission = validateUploadForAdmission({
      declaredMimeType: 'application/pdf',
      byteLength: pdf.byteLength,
      bytes: pdf,
      allowMissingSignatureScanner: true,
    });
    expect(admission.ok).toBe(true); // admitted to quarantine despite hiding an executable PDF action
  });
});
