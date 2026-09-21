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
 *
 * 2026-09-21 UPDATE — SHARED EXTRACTION. The structural scan
 * (`scanPdfStructure`) described above is no longer implemented in this file.
 * An independent audit found FDH-3's own upload routes had NO structural PDF
 * check at all, so the FlateDecode-aware scan was extracted verbatim to
 * `lib/shared/pdfStructuralScan.ts` and both AIE and FDH-3 now import that
 * single implementation, rather than FDH-3 growing a second, drifting copy.
 * This file still owns and re-exports `scanPdfStructure`'s public name for
 * backward compatibility (see the import/re-export block below) — nothing
 * about AIE's own behaviour, allowlist, or limits changed.
 */

import { createHash } from 'node:crypto';
import { scanPdfStructure, type PdfStructuralScanResult } from '@/lib/shared/pdfStructuralScan';

// Re-exported for backward compatibility — every existing caller/test in this
// codebase imports `scanPdfStructure`/`PdfStructuralScanResult` FROM THIS
// FILE (`@/lib/aie/validation/fileValidation`), including
// `tests/unit/aieFileValidation.test.ts` and
// `tests/unit/aie16CertificationAdversarialPdf.test.ts`. The 2026-09-21 FDH-3
// malware-scan-gap remediation pass extracted the actual implementation to
// `lib/shared/pdfStructuralScan.ts` so FDH-3 can call the SAME code instead
// of a drifting copy — this re-export means neither AIE's own imports nor
// its test suite need to change.
export { scanPdfStructure, type PdfStructuralScanResult };

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

// QUA-03 ("reject PDF JavaScript/launch actions/embedded executables/
// disallowed attachments") and QUA-05 ("detect polyglot files/suspicious
// trailing content") are both implemented by `scanPdfStructure`, imported
// above from `lib/shared/pdfStructuralScan.ts` — see that module's header
// for the full disclosed scope, the AIE-1.6 FlateDecode-decompression fix
// history, and the decompression-bomb bounds. It is re-exported at the top
// of this file so no existing import path in this codebase changes.

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
