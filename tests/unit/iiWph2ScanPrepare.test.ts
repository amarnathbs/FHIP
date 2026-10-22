// Document2 (4) WP-H2 -- opening a password-protected statement IN MEMORY so the malware scanner sees real content, never a locked box.
import { describe, expect, it, vi } from 'vitest';
import { prepareBytesForScan, mayBeEncryptedPdf } from '@/lib/services/investment-intelligence/scanPrepare';
import { extractPdfText } from '@/lib/services/investment-intelligence/pdfExtraction';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildEncryptedTextPdf, TEST_USER_PASSWORD, type EncryptAlgorithm } from '../support/buildEncryptedPdf';
import { buildWphCas, PRIME_FOLIO_Q1 } from '../support/buildWphCasText';

const LINES = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [PRIME_FOLIO_Q1] }).split('\n');
const PDF = 'application/pdf';
const ALGORITHMS: EncryptAlgorithm[] = ['AES-256', 'AES-128', 'RC4-128', 'RC4-40'];

describe('what a locked statement looks like to the pipeline', () => {
  it.each(ALGORITHMS)('%s: the synthetic file really is locked (pdf.js asks for a password) and really opens with it', async (algorithm) => {
    const locked = await buildEncryptedTextPdf(LINES, { algorithm });
    expect(mayBeEncryptedPdf(locked)).toBe(true);
    expect(await extractPdfText(new Uint8Array(locked))).toMatchObject({ ok: false, kind: 'password_required' });
    expect((await extractPdfText(new Uint8Array(locked), TEST_USER_PASSWORD)).ok).toBe(true);
  });
});

describe('prepareBytesForScan', () => {
  it.each(ALGORITHMS)('%s: no password -> password_needed; wrong password -> wrong_password; right password -> decrypted bytes the scanner can read', async (algorithm) => {
    const locked = await buildEncryptedTextPdf(LINES, { algorithm });
    const lockedCopy = new Uint8Array(locked);
    expect(await prepareBytesForScan(locked, PDF)).toEqual({ kind: 'password_needed' });
    expect(await prepareBytesForScan(locked, PDF, 'not-the-password')).toEqual({ kind: 'wrong_password' });
    const ok = await prepareBytesForScan(locked, PDF, TEST_USER_PASSWORD);
    expect(ok.kind).toBe('decrypted');
    if (ok.kind !== 'decrypted') return;
    // the decrypted copy is a different file: it opens with NO password and carries the statement text
    expect(Buffer.from(ok.bytes).equals(Buffer.from(lockedCopy))).toBe(false);
    const text = await extractPdfText(new Uint8Array(ok.bytes));
    expect(text.ok && text.text.includes('Folio No: 1122334455')).toBe(true);
    // the caller's own bytes are untouched (they are still the locked original that gets stored and processed)
    expect(Buffer.from(locked).equals(Buffer.from(lockedCopy))).toBe(true);
    // its final trailer no longer names an encryption dictionary
    const tail = Buffer.from(ok.bytes).toString('latin1');
    expect(tail.slice(tail.lastIndexOf('trailer'))).not.toContain('/Encrypt');
  });

  it('owner-password-only protection (empty user password) opens without anyone typing a password', async () => {
    const locked = await buildEncryptedTextPdf(LINES, { userPassword: '' });
    const r = await prepareBytesForScan(locked, PDF);
    expect(r.kind).toBe('decrypted');
  });

  it('a PDF that is not encrypted is scanned as it is, even if the text /Encrypt appears in it', async () => {
    const plain = new Uint8Array(buildMinimalTextPdf([[...LINES, 'This line mentions /Encrypt as plain text']]));
    expect(mayBeEncryptedPdf(plain)).toBe(true);
    expect(await prepareBytesForScan(plain, PDF)).toEqual({ kind: 'as_is' });
    expect(await prepareBytesForScan(new Uint8Array(buildMinimalTextPdf([LINES])), PDF, 'ignored')).toEqual({ kind: 'as_is' });
  });

  it('a non-PDF (csv) is never opened', async () => {
    expect(await prepareBytesForScan(new TextEncoder().encode('a,b\n/Encrypt,1'), 'text/csv', 'x')).toEqual({ kind: 'as_is' });
  });

  it('a file that merely NAMES /Encrypt but that the library reads as an ordinary document is scanned as it is (the scanner then decides; an unreadable file stays refused there)', async () => {
    const junk = new TextEncoder().encode(['%PDF-1.7', '1 0 obj << /Encrypt 5 0 R >> endobj', 'trailer << /Encrypt 5 0 R >>', '%%EOF'].join('\n'));
    expect((await prepareBytesForScan(junk, PDF, TEST_USER_PASSWORD)).kind).toBe('as_is');
  });

  it('the password never appears in any result, error or console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const locked = await buildEncryptedTextPdf(LINES);
      const results = [await prepareBytesForScan(locked, PDF, TEST_USER_PASSWORD), await prepareBytesForScan(locked, PDF, 'wrong-pw-xyz'), await prepareBytesForScan(new TextEncoder().encode('%PDF-1.7 /Encrypt'), PDF, 'junk-pw-123')];
      const serialised = JSON.stringify(results.map((r) => (r.kind === 'decrypted' ? { kind: r.kind } : r)));
      for (const secret of [TEST_USER_PASSWORD, 'wrong-pw-xyz', 'junk-pw-123']) {
        expect(serialised).not.toContain(secret);
        for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(secret);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
