/**
 * FDH-3 — Upload Test Pack (spec section 65), exercised against real
 * committed fixture FILES (tests/fixtures/financial-data-hub/), not just
 * inline byte buffers. All fixtures are synthetic/fictitious — see each
 * fixture's own content; none is a real bank statement.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateUploadedFile } from '@/lib/financial-data-hub/domain/fileValidation';

const FIXTURES = path.resolve(__dirname, '../fixtures/financial-data-hub');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

describe('FDH-3 upload test pack — real fixture files', () => {
  it('valid PDF fixture is accepted', () => {
    const bytes = read('synthetic-bank-statement.pdf');
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(true);
  });

  it('valid CSV fixture is accepted', () => {
    const bytes = read('synthetic-bank-statement.csv');
    const result = validateUploadedFile({ declaredMimeType: 'text/csv', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(true);
  });

  it('password-protected PDF fixture is accepted but flagged passwordRequired', () => {
    const bytes = read('password-protected-synthetic.pdf');
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passwordRequired).toBe(true);
  });

  it('a CSV file renamed with a .pdf extension is rejected as a MIME mismatch when declared as PDF', () => {
    const bytes = read('wrong-extension.pdf');
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['mime_mismatch', 'file_corrupt']).toContain(result.failureCode);
  });

  it('the invalid-pdf fixture is rejected when declared as PDF', () => {
    const bytes = read('invalid-pdf.pdf');
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: bytes.byteLength, bytes });
    expect(result.ok).toBe(false);
  });

  it('an oversized file (generated, never committed to git) is rejected', () => {
    const oversized = Buffer.alloc(21 * 1024 * 1024, 0x41); // 21MB, over the 20MB PDF limit
    const result = validateUploadedFile({ declaredMimeType: 'application/pdf', byteLength: oversized.byteLength, bytes: oversized });
    expect(result).toEqual({ ok: false, failureCode: 'file_too_large' });
  });

  it('a genuinely zero-byte file is rejected', () => {
    const result = validateUploadedFile({ declaredMimeType: 'text/csv', byteLength: 0, bytes: new Uint8Array(0) });
    expect(result).toEqual({ ok: false, failureCode: 'file_corrupt' });
  });

  it('all fixtures are small and clearly synthetic (sanity guard against ever committing a real document)', () => {
    for (const name of fs.readdirSync(FIXTURES)) {
      const stat = fs.statSync(path.join(FIXTURES, name));
      expect(stat.size, `${name} is unexpectedly large for a synthetic fixture`).toBeLessThan(10_000);
    }
  });
});
