// II-PC3 test-only helper: builds a minimal, valid, RC4-40-bit
// (Standard Security Handler V1/R2) PASSWORD-ENCRYPTED, digitally-generated
// multi-page text PDF from plain-text lines, entirely in-process (no
// external tool, no network, no binary fixture checked into git as bytes,
// no third-party PDF-encryption package).
//
// This exists because Node's modern OpenSSL 3 build refuses the legacy RC4
// cipher via crypto.createCipheriv('rc4', ...) ("unsupported" — the legacy
// provider is not loaded by default), exactly the same reason `pdf-parse`
// (pdfjs-dist under the hood) ships its OWN pure-JS RC4 implementation
// rather than relying on the platform's OpenSSL build. This module does the
// same: a from-scratch RC4 (KSA+PRGA) plus the PDF32000 Algorithm 3.1-3.4
// standard-security-handler key derivation, applied to a PDF built with the
// exact same object layout as `buildMinimalTextPdf.ts` (classic xref table,
// uncompressed objects — the simplest, best-documented target for classic
// RC4 encryption, and structurally identical to what a real password-
// protected CAMS/KFintech CAS PDF would use).
//
// Deliberately narrow scope: only the ONE golden encrypted fixture (II-PC3
// Phase 2) needs this. Not used for the R2 golden-fixture catalog (which
// intentionally stays plain-text — see R2_GOLDEN_FIXTURE_CATALOG.md).

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// --- Pure-JS RC4 (symmetric: same function encrypts and decrypts) ---------
function rc4(key: Buffer, data: Buffer): Buffer {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

function md5(data: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto');
  return crypto.createHash('md5').update(data).digest();
}

// PDF32000-1:2008 Table 3.20 / Algorithm 3.2 standard 32-byte padding string.
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(pw: string): Buffer {
  const pwBytes = Buffer.from(pw, 'latin1').subarray(0, 32);
  return Buffer.concat([pwBytes, PAD]).subarray(0, 32);
}

/** Algorithm 3.3 (R2): compute /O entry from the owner (falls back to user) password. */
function computeO(ownerPassword: string, userPassword: string): Buffer {
  const paddedOwner = padPassword(ownerPassword || userPassword);
  const hash = md5(paddedOwner);
  const rc4Key = hash.subarray(0, 5); // 40-bit key = 5 bytes
  const paddedUser = padPassword(userPassword);
  return rc4(rc4Key, paddedUser);
}

/** Algorithm 3.2: compute the file encryption key from the user password, /O, /P and file ID. */
function computeEncryptionKey(userPassword: string, oValue: Buffer, permissions: number, idFirst: Buffer): Buffer {
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(permissions, 0);
  const input = Buffer.concat([padPassword(userPassword), oValue, pBytes, idFirst]);
  const hash = md5(input);
  return hash.subarray(0, 5); // 40-bit
}

/** Algorithm 3.4 (R2): compute /U entry — RC4(PAD) keyed by the file encryption key. */
function computeU(encryptionKey: Buffer): Buffer {
  return rc4(encryptionKey, PAD);
}

/** Algorithm 3.1: per-object encryption key = MD5(fileKey + objNum(3 LE bytes) + genNum(2 LE bytes))[0 .. n+5]. */
function perObjectKey(fileKey: Buffer, objNum: number, genNum: number): Buffer {
  const extra = Buffer.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff, genNum & 0xff, (genNum >> 8) & 0xff]);
  const hash = md5(Buffer.concat([fileKey, extra]));
  const n = fileKey.length + 5; // 10 for 40-bit
  return hash.subarray(0, Math.min(n, 16));
}

function toHexString(buf: Buffer): string {
  return `<${buf.toString('hex').toUpperCase()}>`;
}

export interface EncryptedPdfResult {
  bytes: Buffer;
  userPassword: string;
  ownerPassword: string;
}

/**
 * Builds a real, RC4-40-bit-encrypted, multi-page, selectable-text PDF.
 * `pages` mirrors buildMinimalTextPdf's shape (array of pages, each an
 * array of text lines). The returned bytes are a genuinely encrypted PDF —
 * opening it without the correct password (via pdf-parse, exactly the
 * production extraction path) must fail with PasswordException, and
 * opening it WITH `userPassword` must yield the original text.
 */
export function buildEncryptedTextPdf(pages: string[][], userPassword: string, ownerPassword = `${userPassword}-owner`): EncryptedPdfResult {
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  let nextObjNum = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(nextObjNum++);
    contentObjNums.push(nextObjNum++);
  }
  const fontObjNum = nextObjNum++;
  const encryptObjNum = nextObjNum++;

  // --- File ID (used both as the PDF /ID trailer entry and as Algorithm 3.2's ID input) ---
  const idSeed = md5(Buffer.from(`ii-pc3-qualification-fixture:${userPassword}:${pages.length}`, 'utf8'));

  // --- Encryption key derivation (independent of any specific object's content) ---
  const permissions = -4; // PDF32000 Table 3.20 R2: bits 1-2 = 0 (reserved), bits 3-32 = 1 (allow print/modify/copy/annotate)
  const oValue = computeO(ownerPassword, userPassword);
  const fileKey = computeEncryptionKey(userPassword, oValue, permissions, idSeed);
  const uValue = computeU(fileKey);

  const byNumber = new Map<number, string | { header: string; streamBytes: Buffer } >();
  byNumber.set(1, `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  byNumber.set(2, `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i];
    const parts: string[] = ['BT', '/F1 9 Tf', '50 760 Td'];
    for (let li = 0; li < lines.length; li++) {
      if (li === 0) parts.push(`(${escapePdfText(lines[li])}) Tj`);
      else parts.push('0 -12 Td', `(${escapePdfText(lines[li])}) Tj`);
    }
    parts.push('ET');
    const rawStream = Buffer.from(parts.join('\n'), 'utf8');
    const contentObjNum = contentObjNums[i];
    const key = perObjectKey(fileKey, contentObjNum, 0);
    const encryptedStream = rc4(key, rawStream);
    byNumber.set(contentObjNum, { header: `${contentObjNum} 0 obj\n<< /Length ${encryptedStream.length} >>\nstream\n`, streamBytes: encryptedStream });
    byNumber.set(
      pageObjNums[i],
      `${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R >>\nendobj\n`
    );
  }
  byNumber.set(fontObjNum, `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  byNumber.set(
    encryptObjNum,
    `${encryptObjNum} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O ${toHexString(oValue)} /U ${toHexString(uValue)} /P ${permissions} >>\nendobj\n`
  );

  const totalObjects = encryptObjNum;
  let pdf = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const offsetByNumber = new Map<number, number>();
  for (let n = 1; n <= totalObjects; n++) {
    const entry = byNumber.get(n);
    if (!entry) continue;
    offsetByNumber.set(n, pdf.length);
    if (typeof entry === 'string') {
      pdf = Buffer.concat([pdf, Buffer.from(entry, 'binary')]);
    } else {
      pdf = Buffer.concat([pdf, Buffer.from(entry.header, 'binary'), entry.streamBytes, Buffer.from('\nendstream\nendobj\n', 'binary')]);
    }
  }

  const xrefOffset = pdf.length;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjects; n++) {
    const off = offsetByNumber.get(n);
    xref += off === undefined ? `0000000000 00000 f \n` : `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  const idHex = idSeed.toString('hex').toUpperCase();
  const trailer = `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Encrypt ${encryptObjNum} 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF`;
  pdf = Buffer.concat([pdf, Buffer.from(xref, 'binary'), Buffer.from(trailer, 'binary')]);

  return { bytes: pdf, userPassword, ownerPassword };
}
