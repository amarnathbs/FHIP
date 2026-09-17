/**
 * AIE-1.1 — upload admission + quarantine validation (UPL-05/QUA-01..12).
 *
 * REUSE DECISION. `lib/financial-data-hub/domain/fileValidation.ts` (FDH-3)
 * already implements exactly the magic-byte/MIME/size/hash discipline this
 * phase needs, and its own header explains why no new npm dependency was
 * introduced for it ("node:crypto ... already used elsewhere"). AIE-1.1
 * needs the identical discipline but for a DIFFERENT, broader allowlist (not
 * hardcoded to FDH's two types) and needs additional PDF-structural/malware
 * heuristics FDH-3 explicitly does not attempt (see FDH3_SECURITY_THREAT_MODEL.md
 * threat #6: "No malware/AV scanner integrated ... Disclosed, not hidden.").
 * Rather than importing FDH's module (which is intentionally locked to its
 * own two-type allowlist and constants) or copy-pasting it verbatim, this
 * file re-implements the same pure, dependency-free technique — generalised
 * to an injectable allowlist — and is the one new thing this phase adds:
 * structural malware-adjacent heuristics FDH-3 never had.
 *
 * HONEST SCOPE. No real anti-malware SIGNATURE engine (e.g. ClamAV) is
 * integrated in this pass — none exists anywhere in this codebase today
 * (confirmed by discovery: zero references to clamav/malware.scan/virus.scan
 * in the whole repository), and standing one up is explicitly a
 * separately-scoped infrastructure decision, not a pure-function library
 * change. What IS implemented here, for real, is the STRUCTURAL half of
 * QUA-03/QUA-05/QUA-06 that a signature engine would never catch anyway:
 * detecting embedded PDF JavaScript/launch actions, detecting trailing
 * content after `%%EOF` (a classic polyglot technique), and bounding
 * decompression/object-count exposure by capping how much of the file is
 * ever scanned. `scanForMalwareSignatures()` below is an explicit, disclosed
 * stub matching QUA-02's own fail-closed policy: "fail closed on scanner
 * failure per approved policy" — here, "no scanner is configured" IS a
 * scanner failure, so the stub fails closed (`ok: false`) rather than
 * pretending to pass a scan it never ran, UNLESS the caller explicitly
 * opts into the disclosed no-scanner-configured DEV posture via
 * `allowMissingSignatureScanner`. Wiring exit criteria (AIE-1.1 exit gate)
 * cannot claim malware-scanning FULL PASS on this alone — recorded as an
 * open item in AIE_1_1_IMPLEMENTATION.md.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export interface AieUploadLimits {
  allowedMimeTypes: readonly string[];
  maxBytesByMimeType: Record<string, number>;
  /** Absolute page-count-independent cap on how many bytes of a PDF are
   * ever scanned for structural threats (QUA-07: "decompression/object-
   * count/nesting/page/pixel/parse-time limits"). */
  structuralScanCapBytes: number;
}

export const DEFAULT_AIE_UPLOAD_LIMITS: AieUploadLimits = {
  allowedMimeTypes: ['application/pdf'],
  maxBytesByMimeType: { 'application/pdf': 25 * 1024 * 1024 },
  structuralScanCapBytes: 10 * 1024 * 1024,
};

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const PDF_EOF = Buffer.from('%%EOF', 'ascii');

export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Heuristic PDF-encryption detector — identical technique to FDH-3's
 * `isPdfLikelyPasswordProtected`, independently re-implemented here because
 * AIE-1.1 owns a broader document-type surface than FDH-3's PDF+CSV pair
 * and must not import a module scoped to that pair's own constants. */
const ENCRYPT_TOKEN = Buffer.from('/Encrypt', 'ascii');

export function isPdfLikelyPasswordProtected(bytes: Uint8Array, scanCapBytes: number): boolean {
  const scanned = bytes.length > scanCapBytes ? bytes.subarray(0, scanCapBytes) : bytes;
  return Buffer.from(scanned).includes(ENCRYPT_TOKEN);
}

/**
 * QUA-03: "reject PDF JavaScript/launch actions/embedded executables/
 * disallowed attachments." A real PDF object-model parser is not built here
 * (out of scope for this pass — see module header); instead this scans for
 * the literal PDF dictionary-key tokens that declare those features,
 * re-scanning any `/FlateDecode`-compressed stream's decompressed content
 * too (see `scanFlateDecodeStreamsForDisallowedTokens` below — added after
 * an AIE-1.6 certification pass demonstrated a FlateDecode-wrapped token
 * evaded the original literal-only scan). This is still a heuristic, not a
 * guarantee: a stream compressed with a DIFFERENT or CHAINED filter (LZW,
 * ASCII85, RunLength, or several filters applied together) can still hide
 * the literal token from both scans — disclosed as such, matching FDH-3's
 * own "sufficient to answer X, nothing more" framing.
 */
const DISALLOWED_PDF_TOKENS: { token: Buffer; label: string }[] = [
  { token: Buffer.from('/JavaScript', 'ascii'), label: 'embedded_javascript' },
  { token: Buffer.from('/JS', 'ascii'), label: 'embedded_javascript' },
  { token: Buffer.from('/Launch', 'ascii'), label: 'launch_action' },
  { token: Buffer.from('/EmbeddedFile', 'ascii'), label: 'embedded_file' },
  { token: Buffer.from('/OpenAction', 'ascii'), label: 'auto_open_action' },
];

/**
 * AIE-1.6 certification finding (see AIE_1_6_CERTIFICATION_REPORT.md
 * section 5, "aie16CertificationAdversarialPdf.test.ts"): the literal-token
 * scan above cannot see a token that has been deflate-compressed inside a
 * standard PDF stream object — a completely unremarkable PDF feature, not
 * an exotic attack. Certification CONSTRUCTED a `/JavaScript` action inside
 * a `/Filter /FlateDecode` stream and confirmed it evaded detection
 * entirely. This closes that specific, demonstrated gap: every stream
 * object whose dictionary declares `/FlateDecode` is decompressed (best
 * effort) and the same disallowed-token scan is re-run against its
 * decompressed content.
 *
 * This remains a HEURISTIC, not a full PDF object-model parser (still
 * disclosed as such) — it does not handle streams compressed with a
 * DIFFERENT filter (LZW, ASCII85, RunLength, or a `/Filter` ARRAY chaining
 * more than one, e.g. `[/ASCII85Decode /FlateDecode]`), and it locates
 * stream/dictionary boundaries with a bounded literal-byte scan rather than
 * a real tokenizer. A sufficiently adversarial combination of those
 * remaining gaps could still evade it — this is one closed hole, not a
 * claim of "solved." A real PDF-parsing library or a genuine anti-malware
 * signature engine remains the only way to close this class of gap fully,
 * and is still explicitly out of scope for this pass (see module header).
 *
 * Decompression-bomb guard: both the NUMBER of streams inspected and the
 * TOTAL decompressed bytes scanned across the whole file are capped,
 * independent of and in addition to the outer structuralScanCapBytes (which
 * only bounds the RAW/compressed bytes read). A stream that would exceed
 * the remaining decompressed-byte budget is flagged as suspicious in its
 * own right (`oversized_compressed_stream`) rather than silently skipped —
 * a compressed object that expands far past what genuine PDF content needs
 * is itself an anomaly worth surfacing, not just an inconvenience to scan
 * around.
 */
const STREAM_KEYWORD = Buffer.from('stream', 'ascii');
const ENDSTREAM_KEYWORD = Buffer.from('endstream', 'ascii');
const FLATE_DECODE_TOKEN = Buffer.from('/FlateDecode', 'ascii');
const STREAM_DICT_LOOKBACK_BYTES = 2000; // bounded window to find this stream's own dictionary
const MAX_FLATE_STREAMS_SCANNED = 200; // bounds parse time on a pathological object count
const MAX_DECOMPRESSED_SCAN_BYTES = 20 * 1024 * 1024; // bounds total decompression work/memory

function scanFlateDecodeStreamsForDisallowedTokens(buf: Buffer): string[] {
  const reasons = new Set<string>();
  let searchFrom = 0;
  let streamsScanned = 0;
  let decompressedBytesUsed = 0;

  while (streamsScanned < MAX_FLATE_STREAMS_SCANNED) {
    const streamKeywordIndex = buf.indexOf(STREAM_KEYWORD, searchFrom);
    if (streamKeywordIndex === -1) break;

    const endIndex = buf.indexOf(ENDSTREAM_KEYWORD, streamKeywordIndex + STREAM_KEYWORD.length);
    if (endIndex === -1) break; // malformed/truncated tail — nothing more to scan

    const dictLookbackStart = Math.max(0, streamKeywordIndex - STREAM_DICT_LOOKBACK_BYTES);
    const isFlateDecode = buf.subarray(dictLookbackStart, streamKeywordIndex).includes(FLATE_DECODE_TOKEN);

    if (isFlateDecode) {
      // The PDF spec requires an EOL (CR, LF, or CRLF) immediately after the
      // `stream` keyword before the raw stream data begins.
      let rawStart = streamKeywordIndex + STREAM_KEYWORD.length;
      if (buf[rawStart] === 0x0d) rawStart++;
      if (buf[rawStart] === 0x0a) rawStart++;
      const rawBytes = buf.subarray(rawStart, endIndex);

      const remainingBudget = MAX_DECOMPRESSED_SCAN_BYTES - decompressedBytesUsed;
      if (remainingBudget <= 0) {
        reasons.add('oversized_compressed_stream');
      } else {
        try {
          const decompressed = inflateSync(rawBytes, { maxOutputLength: remainingBudget });
          decompressedBytesUsed += decompressed.length;
          for (const { token, label } of DISALLOWED_PDF_TOKENS) {
            if (decompressed.includes(token)) reasons.add(label);
          }
        } catch (err) {
          // ERR_BUFFER_TOO_LARGE means this one stream alone would exceed
          // the remaining decompression budget — flag it explicitly rather
          // than silently skipping, per this function's own header.
          // Any OTHER zlib error (corrupt data, a different/layered filter
          // this heuristic doesn't attempt to unwrap, a truncated stream)
          // is not itself evidence of anything — this is a best-effort
          // heuristic scan, not a full parser, matching this module's own
          // disclosed "heuristic, not a guarantee" framing throughout.
          if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
            reasons.add('oversized_compressed_stream');
          }
        }
      }
    }

    streamsScanned++;
    searchFrom = endIndex + ENDSTREAM_KEYWORD.length;
  }

  return Array.from(reasons);
}

export interface PdfStructuralScanResult {
  suspicious: boolean;
  reasons: string[];
  /** QUA-05: "detect polyglot files/suspicious trailing content." */
  hasTrailingContentAfterEof: boolean;
}

export function scanPdfStructure(bytes: Uint8Array, scanCapBytes: number): PdfStructuralScanResult {
  const scanned = bytes.length > scanCapBytes ? bytes.subarray(0, scanCapBytes) : bytes;
  const buf = Buffer.from(scanned);
  const reasons: string[] = [];
  for (const { token, label } of DISALLOWED_PDF_TOKENS) {
    if (buf.includes(token) && !reasons.includes(label)) reasons.push(label);
  }
  for (const label of scanFlateDecodeStreamsForDisallowedTokens(buf)) {
    if (!reasons.includes(label)) reasons.push(label);
  }

  // Trailing-content-after-%%EOF check runs over the FULL file (bounded to a
  // fixed tail window), independent of the head-only structural scan cap,
  // since a polyglot payload is deliberately appended at the end.
  const lastEofIndex = Buffer.from(bytes).lastIndexOf(PDF_EOF);
  let hasTrailingContentAfterEof = false;
  if (lastEofIndex >= 0) {
    const afterEof = bytes.subarray(lastEofIndex + PDF_EOF.length);
    // A handful of trailing whitespace/newline bytes is normal; anything
    // else after the last %%EOF marker is not.
    const trimmed = Buffer.from(afterEof).toString('latin1').replace(/[\r\n\s]/g, '');
    hasTrailingContentAfterEof = trimmed.length > 0;
  }
  if (hasTrailingContentAfterEof) reasons.push('trailing_content_after_eof');

  return { suspicious: reasons.length > 0, reasons, hasTrailingContentAfterEof };
}

/**
 * Disclosed stub (see module header). No signature-based scanner is wired
 * up in this pass. Fails closed by default; the DEV-only override exists so
 * unit/integration tests and local development are not permanently blocked
 * on infrastructure this pass does not stand up.
 */
export function scanForMalwareSignatures(options?: { allowMissingSignatureScanner?: boolean }): {
  ok: boolean;
  reason: 'no_scanner_configured' | 'passed';
} {
  if (options?.allowMissingSignatureScanner) {
    return { ok: true, reason: 'no_scanner_configured' };
  }
  return { ok: false, reason: 'no_scanner_configured' };
}

export type AdmissionValidationOutcome =
  | {
      ok: true;
      detectedMimeType: string;
      fileHash: string;
      passwordRequired: boolean;
      structuralWarnings: string[];
    }
  | {
      ok: false;
      failureCode:
        | 'unsupported_file_type'
        | 'file_too_large'
        | 'mime_mismatch'
        | 'file_corrupt'
        | 'structural_reject'
        | 'malware_scan_failed_closed';
    };

/**
 * The complete AIE-1.1 admission pipeline for PDF documents (architecture
 * steps 1-3: admission -> quarantine -> malware/MIME/structural/resource-
 * limit validation). Order matches FDH-3's own precedent: cheap checks
 * (allowlist, size) before any byte-content inspection, and byte-content
 * inspection before the more expensive structural scan.
 */
export function validateUploadForAdmission(input: {
  declaredMimeType: string;
  byteLength: number;
  bytes: Uint8Array;
  limits?: AieUploadLimits;
  allowMissingSignatureScanner?: boolean;
}): AdmissionValidationOutcome {
  const limits = input.limits ?? DEFAULT_AIE_UPLOAD_LIMITS;

  if (!limits.allowedMimeTypes.includes(input.declaredMimeType)) {
    return { ok: false, failureCode: 'unsupported_file_type' };
  }
  const maxBytes = limits.maxBytesByMimeType[input.declaredMimeType];
  if (input.byteLength <= 0) return { ok: false, failureCode: 'file_corrupt' };
  if (maxBytes != null && input.byteLength > maxBytes) return { ok: false, failureCode: 'file_too_large' };

  // Today only application/pdf is admitted (DEFAULT_AIE_UPLOAD_LIMITS) — the
  // detection function is written generically so a future document class
  // can be added to the allowlist without restructuring this pipeline.
  const detected = looksLikePdf(input.bytes) ? 'application/pdf' : null;
  if (!detected) return { ok: false, failureCode: 'file_corrupt' };
  if (detected !== input.declaredMimeType) return { ok: false, failureCode: 'mime_mismatch' };

  const scan = scanForMalwareSignatures({ allowMissingSignatureScanner: input.allowMissingSignatureScanner });
  if (!scan.ok) return { ok: false, failureCode: 'malware_scan_failed_closed' };

  const structural = scanPdfStructure(input.bytes, limits.structuralScanCapBytes);
  if (structural.suspicious) return { ok: false, failureCode: 'structural_reject' };

  const passwordRequired = isPdfLikelyPasswordProtected(input.bytes, limits.structuralScanCapBytes);

  return {
    ok: true,
    detectedMimeType: detected,
    fileHash: sha256Hex(input.bytes),
    passwordRequired,
    structuralWarnings: [],
  };
}
