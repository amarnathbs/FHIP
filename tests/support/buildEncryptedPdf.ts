// Document2 (4) WP-H2 -- synthetic PASSWORD-PROTECTED statement PDFs for tests. Every password here is a throwaway test constant; no
// real statement password is used anywhere in this repository.
import { PDFDocument } from '@cantoo/pdf-lib';
import { buildMinimalTextPdf } from './buildMinimalPdf';

export type EncryptAlgorithm = 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40';
export const TEST_USER_PASSWORD = 'synthetic-user-pw-0001';
export const TEST_OWNER_PASSWORD = 'synthetic-owner-pw-0002';

/** A real PDF with the given text lines, encrypted with the given algorithm (user password optional: owner-only protection when empty). */
export async function buildEncryptedTextPdf(lines: string[], opts: { algorithm?: EncryptAlgorithm; userPassword?: string; ownerPassword?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(new Uint8Array(buildMinimalTextPdf([lines])));
  const algorithm = opts.algorithm ?? 'AES-256';
  doc.encrypt({
    userPassword: opts.userPassword ?? TEST_USER_PASSWORD,
    ownerPassword: opts.ownerPassword ?? TEST_OWNER_PASSWORD,
    permissions: { printing: true },
    algorithm,
    allowWeakCryptography: algorithm.startsWith('RC4'),
  } as never);
  return doc.save();
}
