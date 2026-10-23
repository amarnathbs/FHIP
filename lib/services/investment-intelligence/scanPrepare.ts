// Investment Intelligence -- what bytes does the malware scanner get to see? (Document2 (4) WP-H2, 22-10-2026)
//
// ROOT CAUSE this module answers. Every CAMS / KFintech consolidated statement is a password-protected PDF. GuardDuty Malware
// Protection for S3 cannot look inside an encrypted PDF: it tags the object GuardDutyMalwareScanStatus UNSUPPORTED. scanPolling.ts
// maps UNSUPPORTED to a SKIPPED scan, scanResultHandler.ts maps SKIPPED to block_unsupported_or_access_denied, realScanGate.ts maps
// that to the stored status `suspicious`, and the callers answer "could not be cleared by our security scan ... has been deleted".
// So with the real scan switched on, EVERY genuine password-protected statement was refused (first upload and replacement alike).
//
// THE SAFE HANDLING (no weakening: a file that cannot be scanned either way is still refused).
//   * The person's document password is used to open the PDF IN MEMORY, and the DECRYPTED bytes are what the scanner is given. The
//     scan object is deleted straight after the verdict (existing strict-deletion purge). The decrypted copy is never persisted
//     anywhere else: not in storage, not in the database, not in a log.
//   * The password is never stored, logged, audited, put in a URL, put in an error message, or sent to the scan bucket. Library error
//     messages are never surfaced either: only the closed set of outcomes below leaves this module.
//   * A missing or wrong password is the ordinary "password required / incorrect" flow, never a scan verdict, and deletes nothing.
//   * A PDF that is not encrypted is scanned exactly as before. An unencrypted file the scanner calls UNSUPPORTED stays refused.
//   * A protection this library cannot open is `cannot_decrypt`: refused (it cannot be scanned), with its own honest wording.
//
// RESIDUAL EXPOSURE, stated plainly: opening the encrypted container requires parsing its structure (pure JavaScript, the same
// family of code that parses every PDF in this product) BEFORE the scan has seen anything. Only the person's own password opens the
// file, and nothing is executed or stored. The scan then covers the decrypted content, which an encrypted container hides from it.

export type ScanPrepared =
  | { kind: 'as_is' }
  | { kind: 'decrypted'; bytes: Uint8Array }
  | { kind: 'password_needed' }
  | { kind: 'wrong_password' }
  | { kind: 'cannot_decrypt' };

const ENCRYPT_TOKEN = Buffer.from('/Encrypt', 'latin1');

/** Cheap pre-check, no parsing: an encrypted PDF always names an /Encrypt dictionary in its trailer or cross-reference stream. */
export function mayBeEncryptedPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ENCRYPT_TOKEN);
}

export async function prepareBytesForScan(bytes: Uint8Array, mimeType: string, password?: string): Promise<ScanPrepared> {
  if (mimeType !== 'application/pdf' || !mayBeEncryptedPdf(bytes)) return { kind: 'as_is' };
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  // The library may take ownership of the buffer it is given: always hand it copies.
  try {
    await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
    return { kind: 'as_is' }; // the token was only text: the file is not encrypted
  } catch (e) {
    // The library's own "this document is encrypted" refusal (matched by name or text, never by class identity across module copies).
    const named = e instanceof Error && (e.name === 'EncryptedPDFError' || /document .*is encrypted/i.test(e.message));
    if (!named) return { kind: 'cannot_decrypt' };
  }
  const supplied = typeof password === 'string' && password.length > 0;
  try {
    // An empty password is tried first when none was given: many statements are encrypted with an owner password only.
    const doc = await PDFDocument.load(new Uint8Array(bytes), { password: supplied ? password : '', updateMetadata: false });
    // NOTHING is stripped from the copy. The loader keeps the original cross-reference containers and the encryption dictionary as ordinary
    // objects (so the old text /Encrypt can still appear inside the file, though the final trailer no longer names it): removing objects
    // would hide bytes from the scanner, and the scanner must see everything the person's file contains.
    const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    return { kind: 'decrypted', bytes: out };
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (/password incorrect|needs password/i.test(message)) return { kind: supplied ? 'wrong_password' : 'password_needed' };
    return { kind: 'cannot_decrypt' }; // an unsupported cipher or a damaged file; the message is dropped on purpose
  }
}
