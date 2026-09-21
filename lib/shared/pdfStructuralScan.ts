/**
 * Shared PDF structural/heuristic threat scan.
 *
 * EXTRACTED (not reimplemented) from `lib/aie/validation/fileValidation.ts`
 * during the FDH-3 malware-scan-gap remediation pass (2026-09-21). Until this
 * pass, this exact FlateDecode-aware scan existed ONLY inside the AIE
 * document-extraction pipeline; FDH-3's own upload routes (bank-csv,
 * bank-pdf, payslip, liability/investment/retirement-statement) had NO
 * structural PDF check at all — an independent audit found zero
 * malware/virus-scan integration anywhere in FDH-3's intake path. This module
 * is the shared, single-source-of-truth home for the scan so both AIE and
 * FDH-3 call the SAME implementation instead of drifting copies.
 *
 * HONEST SCOPE — read this before calling this a "malware scanner" anywhere.
 * This is STRUCTURAL/HEURISTIC validation only. It:
 *   - scans raw bytes (and every declared `/FlateDecode` stream's
 *     decompressed content) for a small, fixed set of PDF dictionary tokens
 *     that declare embedded JavaScript, launch actions, embedded files or
 *     auto-open actions;
 *   - detects polyglot-style trailing content appended after the last
 *     `%%EOF` marker;
 *   - bounds its own work with a raw-byte scan cap, a per-file stream-count
 *     cap and a total-decompressed-bytes cap, so a pathological input cannot
 *     turn this into an unbounded-time/memory operation (a "zip-bomb"-shaped
 *     PDF is flagged as suspicious in its own right rather than silently
 *     skipped or left to exhaust memory).
 *
 * It is NOT a real anti-malware engine. There is no signature database, no
 * behavioural sandbox, no AV/EDR integration anywhere in this codebase today
 * (confirmed by discovery: zero references to clamav/malware.scan/virus.scan
 * outside this disclosed-stub commentary, for either AIE or FDH-3). A
 * well-formed malicious PDF/CSV that does not use one of the specific,
 * disclosed bypass techniques above (or a stream compressed with a filter
 * OTHER than FlateDecode, or a chained `/Filter` array) will not be caught by
 * this scan. See `docs/financial-data-hub/FDH3_SHARED_MALWARE_GATE_DESIGN.md`
 * for the actual eventual real-scanner architecture (S3 quarantine +
 * GuardDuty Malware Protection), which this module does not attempt to be a
 * substitute for.
 *
 * PROVENANCE OF THE FlateDecode FIX. The decompression re-scan below was
 * added during an AIE-1.6 certification pass after certification
 * demonstrated a `/JavaScript` action hidden inside a `/Filter /FlateDecode`
 * stream evaded the original literal-only token scan entirely (see
 * `docs/aie-programme/AIE_1_6_CERTIFICATION_REPORT.md` section 5 and
 * `tests/unit/aie16CertificationAdversarialPdf.test.ts`, which is preserved
 * unchanged and continues to import this scan via
 * `lib/aie/validation/fileValidation.ts`'s re-export). That history is kept
 * here verbatim rather than summarised away, since it is the reason several
 * of this function's bounds and behaviours exist at all.
 */

import { inflateSync } from 'node:zlib';

const PDF_EOF = Buffer.from('%%EOF', 'ascii');

const DISALLOWED_PDF_TOKENS: { token: Buffer; label: string }[] = [
  { token: Buffer.from('/JavaScript', 'ascii'), label: 'embedded_javascript' },
  { token: Buffer.from('/JS', 'ascii'), label: 'embedded_javascript' },
  { token: Buffer.from('/Launch', 'ascii'), label: 'launch_action' },
  { token: Buffer.from('/EmbeddedFile', 'ascii'), label: 'embedded_file' },
  { token: Buffer.from('/OpenAction', 'ascii'), label: 'auto_open_action' },
];

/**
 * Decompression-bomb guard: both the NUMBER of streams inspected and the
 * TOTAL decompressed bytes scanned across the whole file are capped,
 * independent of and in addition to the caller's own raw-byte scan cap
 * (which only bounds the RAW/compressed bytes read). A stream that would
 * exceed the remaining decompressed-byte budget is flagged as suspicious in
 * its own right (`oversized_compressed_stream`) rather than silently skipped
 * — a compressed object that expands far past what genuine PDF content needs
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
  /** Detects polyglot files/suspicious trailing content after `%%EOF`. */
  hasTrailingContentAfterEof: boolean;
}

/**
 * Scans raw PDF bytes for a fixed set of disallowed structural tokens
 * (embedded JavaScript/launch actions/embedded files/auto-open actions),
 * including inside every declared `/FlateDecode` stream's decompressed
 * content, plus polyglot-style trailing content after the last `%%EOF`.
 *
 * `scanCapBytes` bounds how much of the RAW file is scanned for literal
 * tokens and how far back trailing-content detection looks; it does NOT
 * bound decompression work, which has its own independent caps above.
 *
 * This is a heuristic, not a full PDF object-model parser — see this
 * module's header for the complete, disclosed list of what it does and does
 * not catch.
 */
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
