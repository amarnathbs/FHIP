/**
 * AIE-1.6 independent certification — adversarial hostile-document probe
 * (not part of any AIE-1.x phase's own test suite). Confirms, by actually
 * constructing and scanning bytes (not just reading the source comment),
 * whether the disclosed limitation in `scanPdfStructure`'s own header
 * ("a sufficiently obfuscated/compressed object stream could hide the
 * literal token") is real and exploitable in this exact implementation.
 *
 * UPDATED during the AIE-1 live-DEV verification pass
 * (docs/aie-programme/AIE_1_LIVE_DEV_VERIFICATION_REPORT.md): this file
 * originally asserted the PRE-FIX vulnerable behaviour ("NOT caught") as
 * "documented current behaviour". `fix/aie-1-1-pdf-flatedecode-detection`
 * (commit 1afceec, merged into this branch) fixed `scanPdfStructure` to
 * decompress and re-scan `/FlateDecode` streams, but did not update this
 * certification-artifact test file (only `tests/unit/aieFileValidation.test.ts`
 * gained new fix-specific tests) — so this file was left silently asserting
 * the OLD, now-incorrect behaviour, and running it against the fixed code
 * fails (`expected true to be false`). Fixed here to assert the CURRENT,
 * correct, fixed behaviour instead, so this file keeps doing its one job:
 * proving the exact adversarial scenario from the AIE-1.6 report stays
 * caught, as a regression guard, rather than silently bit-rotting into a
 * false "still vulnerable" record.
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

  it('the FlateDecode-hidden /JavaScript token from the AIE-1.6 certification finding IS now caught (fix/aie-1-1-pdf-flatedecode-detection regression guard)', () => {
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
    // Post-fix (commit 1afceec): scanPdfStructure now decompresses
    // /FlateDecode streams and re-scans the decompressed bytes, so the
    // hidden /JavaScript token IS found.
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('embedded_javascript');

    // End-to-end: the SAME hostile bytes must now be REJECTED by full
    // admission, even with the "no scanner configured" DEV override on —
    // the FlateDecode re-scan is part of scanPdfStructure itself, not the
    // optional external signature scanner.
    const admission = validateUploadForAdmission({
      declaredMimeType: 'application/pdf',
      byteLength: pdf.byteLength,
      bytes: pdf,
      allowMissingSignatureScanner: true,
    });
    expect(admission.ok).toBe(false); // no longer admitted to quarantine
  });
});
