// Investment Intelligence — upload admission scan (2026-09-21 fix).
//
// THE GAP THIS CLOSES. M13A's production-readiness pass (2026-09-21,
// mission/m13-production-activation-2026-09-21, docs/aie-programme/
// M13A_PRODUCTION_READINESS_CERTIFICATION_2026-09-21.md) found that
// `app/api/investment-intelligence/source-documents/route.ts` — the upload
// surface for the OLD Investment Intelligence AI-fallback path
// (aiFallbackDocumentExtraction.ts, wired in 2026-09-20) — had NO
// magic-byte/structural-scan admission check of its own. Its only checks
// were `validateUploadedFile` (storage.ts): file extension, declared MIME
// type, and size — never a single byte of the file's actual content.
//
// REUSE DECISION. `lib/aie/validation/fileValidation.ts` (AIE-1.1) already
// implements exactly the structural discipline this gap needs —
// `looksLikePdf` (magic-byte confirmation) and `scanPdfStructure` (rejects
// embedded PDF JavaScript/launch actions/embedded files/auto-open actions,
// including inside `/FlateDecode`-compressed streams, and detects polyglot
// trailing content after `%%EOF`) — so this file calls those two functions
// directly rather than re-implementing the same heuristics a third time.
//
// WHY NOT THE WHOLE `validateUploadForAdmission()` PIPELINE. That function
// also runs `scanForMalwareSignatures()`, a disclosed stub that fails CLOSED
// whenever `allowMissingSignatureScanner` is not set — correct for the AIE
// intake routes, which are ALL independently gated behind their own
// off-by-default kill switches (`AIE_DOCUMENT_INTAKE_ENABLED`, the per-
// adapter flags, the pilot cohort), so failing closed there costs nothing:
// nothing is reachable in production regardless. THIS route has no such
// gate — it is the live, unconditional upload path every Investment
// Intelligence user already depends on for ordinary, non-AI-fallback
// PDF/CSV statement uploads. Wiring the same "no scanner configured, fail
// closed" stub here would reject every legitimate PDF the moment this
// ships, which is a functional regression to the whole feature, not a
// security fix — and the gap M13A named was "zero structural check", not
// "no signature-based malware engine" (no such engine exists anywhere in
// this codebase today; standing one up is a separate, disclosed
// infrastructure decision — see FDH3_SECURITY_THREAT_MODEL.md threat #6 and
// fileValidation.ts's own header). CSV uploads are left to the existing
// extension/MIME/size checks; the PDF-structural heuristics below do not
// apply to CSV and this codebase has no CSV-malware threat model to scan
// against (same scope FDH-3 and AIE-1.1 both draw).
//
// This runs BEFORE the file is written to storage and BEFORE any
// `ii_source_documents` row is created — a structurally-rejected file is
// never persisted, so it can never later reach documentProcessing.ts's
// parsing or AI-fallback path.

import { looksLikePdf, scanPdfStructure } from '@/lib/aie/validation/fileValidation';

export type UploadAdmissionFailureCode = 'file_corrupt' | 'structural_reject';

export type UploadAdmissionResult =
  | { ok: true }
  | { ok: false; failureCode: UploadAdmissionFailureCode; reasons: string[] };

// Same bound AIE-1.1 uses (DEFAULT_AIE_UPLOAD_LIMITS.structuralScanCapBytes)
// — independent of this route's own 20MB upload ceiling (storage.ts's
// MAX_FILE_SIZE_BYTES), which is enforced separately by validateUploadedFile
// before this function is ever called.
const STRUCTURAL_SCAN_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Structural admission scan for a declared `application/pdf` upload. Callers
 * must only invoke this for files whose declared MIME type is
 * `application/pdf` (checked upstream by `validateUploadedFile`) — CSV
 * uploads should not be passed here.
 */
export function scanUploadedPdfForAdmission(bytes: Uint8Array): UploadAdmissionResult {
  if (!looksLikePdf(bytes)) {
    return { ok: false, failureCode: 'file_corrupt', reasons: ['not_a_pdf'] };
  }
  const structural = scanPdfStructure(bytes, STRUCTURAL_SCAN_CAP_BYTES);
  if (structural.suspicious) {
    return { ok: false, failureCode: 'structural_reject', reasons: structural.reasons };
  }
  return { ok: true };
}

/** Honest, non-alarmist user-facing text for each failure code — never
 * claims a real anti-malware scan ran (see module header). */
export function uploadAdmissionFailureMessage(failureCode: UploadAdmissionFailureCode): string {
  switch (failureCode) {
    case 'file_corrupt':
      return 'This file does not look like a valid PDF and was rejected.';
    case 'structural_reject':
      return 'This PDF contains content (such as an embedded script, an auto-open/launch action, or unexpected trailing data) that this platform does not accept, and was rejected.';
    default:
      return 'This file could not be admitted.';
  }
}
