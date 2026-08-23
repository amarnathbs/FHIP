/**
 * Financial Data Hub — FDH-3 file-safety inspection.
 *
 * Pure functions over raw bytes. No network access, no filesystem access, no
 * external service call, no parsing of document CONTENT (spec sections
 * 82-84: no OCR, no PDF text extraction, no CSV row interpretation — this
 * module inspects enough STRUCTURE to answer "is this plausibly the file type
 * it claims to be" and "is this PDF encrypted", nothing more).
 *
 * DEPENDENCY DECISION (spec section 81). No new npm package is introduced.
 * A PDF's magic bytes and its `/Encrypt` trailer token are both detectable
 * with a handful of bytes of inspection; pulling in a general "file-type"
 * or "pdf-parse" library for that would be an unreviewed, unnecessary
 * dependency. `node:crypto` (already used elsewhere in this repository) is
 * used for SHA-256 hashing.
 */

import { createHash } from 'node:crypto';
import { FDH_ALLOWED_UPLOAD_MIME_TYPES, type FdhAllowedUploadMimeType } from '../constants/enums';

/** Practical initial size limits (spec section 19), chosen from the shape of
 * a real financial statement: a multi-year, multi-account PDF export can run
 * to several megabytes; a CSV export is text and rarely exceeds a few MB even
 * for a long history. Both leave meaningful headroom over the typical case
 * without accepting an unbounded upload. */
export const FDH_MAX_FILE_SIZE_BYTES: Record<FdhAllowedUploadMimeType, number> = {
  'application/pdf': 20 * 1024 * 1024, // 20 MB
  'text/csv': 10 * 1024 * 1024, // 10 MB
};

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

/** Only the first 5 bytes are inspected — enough to identify the format,
 * never enough to parse document content. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC);
}

/**
 * CSV has no magic bytes — it is only decided by declared MIME/extension
 * plus "is this plausibly text". A renamed binary (executable, image, zip)
 * is rejected here because it is NOT plausibly text: it will contain a NUL
 * byte or a majority of non-printable bytes well within the first few
 * kilobytes, which no legitimate CSV export does.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // a NUL byte never appears in real text
    // Allow tab (9), LF (10), CR (13) and the printable/UTF-8 range;
    // anything else in the C0 control range is a strong binary signal.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controlBytes += 1;
  }
  return controlBytes / sample.length < 0.01;
}

/**
 * Detects the actual file type from its bytes, independent of what the
 * caller (or the browser) declared. Returns null if the bytes do not
 * plausibly match ANY allowed type — the caller must then reject the upload
 * as `unsupported_file_type` or `file_corrupt`, never guess.
 */
export function detectFileTypeFromBytes(bytes: Uint8Array): FdhAllowedUploadMimeType | null {
  if (looksLikePdf(bytes)) return 'application/pdf';
  if (looksLikeText(bytes)) return 'text/csv';
  return null;
}

/**
 * Bounded heuristic PDF-encryption detector (spec section 22 / 83). Real PDF
 * encryption is declared by an `/Encrypt` reference in the trailer
 * dictionary. This scans for that literal token in the raw bytes rather than
 * building a PDF object-model parser — sufficient to raise
 * `PDF_PASSWORD_REQUIRED` before any parser phase runs, and explicitly NOT a
 * claim of full PDF-structure validation. The scan is capped (never the
 * whole of an arbitrarily large file) purely as a defensive bound, matching
 * the "no unbounded work on attacker-controlled input" principle used
 * elsewhere in file validation.
 */
const ENCRYPT_TOKEN = Buffer.from('/Encrypt', 'ascii');
const ENCRYPT_SCAN_CAP_BYTES = 5 * 1024 * 1024; // 5 MB

export function isPdfLikelyPasswordProtected(bytes: Uint8Array): boolean {
  const scanned = bytes.length > ENCRYPT_SCAN_CAP_BYTES ? bytes.subarray(0, ENCRYPT_SCAN_CAP_BYTES) : bytes;
  return Buffer.from(scanned).includes(ENCRYPT_TOKEN);
}

/** SHA-256 hex digest — the same format `fdhFileHash` (validation/documents.ts)
 * already expects and `fdh_statement_uploads.file_hash` already stores. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type FileValidationOutcome =
  | { ok: true; detectedMimeType: FdhAllowedUploadMimeType; fileHash: string; passwordRequired: boolean }
  | { ok: false; failureCode: 'unsupported_file_type' | 'file_too_large' | 'mime_mismatch' | 'file_corrupt' };

/**
 * The complete FDH-3 upload-time inspection: allowlist + size limit +
 * declared-vs-actual MIME agreement + magic-byte detection + (for PDF)
 * encryption detection + hashing. Order matters: cheap checks (size,
 * allowlist) run before any byte-content inspection.
 *
 * A password-protected PDF is NOT rejected here — it is a valid upload that
 * cannot be parsed without a password later (spec section 22). The caller
 * surfaces `passwordRequired` and lets the document proceed to
 * `review_required` rather than `failed`.
 */
export function validateUploadedFile(input: {
  declaredMimeType: string;
  byteLength: number;
  bytes: Uint8Array;
}): FileValidationOutcome {
  const declared = input.declaredMimeType as FdhAllowedUploadMimeType;
  if (!(FDH_ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(declared)) {
    return { ok: false, failureCode: 'unsupported_file_type' };
  }
  const maxSize = FDH_MAX_FILE_SIZE_BYTES[declared];
  if (input.byteLength <= 0) return { ok: false, failureCode: 'file_corrupt' };
  if (input.byteLength > maxSize) return { ok: false, failureCode: 'file_too_large' };

  const detected = detectFileTypeFromBytes(input.bytes);
  if (!detected) return { ok: false, failureCode: 'file_corrupt' };
  if (detected !== declared) return { ok: false, failureCode: 'mime_mismatch' };

  const passwordRequired = detected === 'application/pdf' && isPdfLikelyPasswordProtected(input.bytes);
  return {
    ok: true,
    detectedMimeType: detected,
    fileHash: sha256Hex(input.bytes),
    passwordRequired,
  };
}
