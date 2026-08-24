/**
 * FDH-5 — OCR fallback architecture (spec sections 8, 13, 41-48, 78, 93-94,
 * 130).
 *
 * SCOPE DECISION (spec 42-43, section 4 "Non-Negotiable Architectural Rule",
 * and the orchestration STOP condition it maps to). This module defines the
 * OCR fallback's CONTRACT and where it plugs into the pipeline — it does
 * NOT call any third-party OCR/document-intelligence provider in this
 * phase.
 *
 * Spec 42 requires, before any live OCR integration: inspecting existing
 * infrastructure for a provider already in use, and — if none exists —
 * choosing one only after documenting privacy/data-residency/retention/
 * training-data implications. Spec 43 is explicit: "If contractual/privacy
 * facts cannot be established: STOP before production integration."
 *
 * This repository's `.env.local` (the only credential source available to
 * this implementation) has NO OCR/document-intelligence provider configured
 * anywhere — not for Investment Intelligence, not for FDH, not anywhere
 * else in the codebase (verified by inspection: no `AZURE_*`, `AWS_*`,
 * `GOOGLE_*_VISION`, `*_OCR_*`, `TESSERACT_*` key exists). Selecting and
 * contracting with a NEW third-party OCR provider is a genuine product/legal
 * decision (data-processing agreement, region, retention, training-data
 * opt-out, Privacy Policy wording) that cannot be manufactured inside a
 * single implementation session — doing so would violate spec 43's STOP
 * condition outright. FDH5_OCR_ARCHITECTURE.md records this decision in
 * full, including which candidate providers were considered and what a
 * future integration would need to supply.
 *
 * WHAT THIS MEANS FOR CORRECTNESS (spec 7). An IMAGE_ONLY or sufficiently
 * sparse MIXED_CONTENT PDF is never guessed at: `classification.ts` already
 * reports it accurately, and the processing service (below) routes it to a
 * clean, honest `PDF_OCR_REQUIRED` failure state rather than fabricating
 * OCR output. This is the SAFE, spec-compliant behaviour explicitly
 * preferred by spec 7 ("prefer REVIEW_REQUIRED or UNSUPPORTED_FORMAT over
 * importing uncertain financial data") over a half-integrated OCR call.
 */

export type OcrEligibility = 'not_required' | 'eligible_not_available';

/**
 * Determines whether a classified PDF WOULD be an OCR candidate, without
 * attempting any OCR — purely a routing decision for the processing
 * service. `'eligible_not_available'` is the honest terminal state this
 * phase reaches for an image-only/scanned statement.
 */
export function determineOcrEligibility(classification: 'text_native' | 'image_only' | 'mixed_content'): OcrEligibility {
  return classification === 'text_native' ? 'not_required' : 'eligible_not_available';
}

/**
 * The three confidence dimensions spec 44 requires to stay independent,
 * modelled here so a future OCR integration has a concrete contract to fill
 * in rather than inventing one under time pressure. NOTHING in FDH-5
 * currently produces a real `ocrConfidence` value (no OCR call exists) —
 * this type exists for the architecture, not for present use.
 */
export interface OcrConfidenceModel {
  /** Did the OCR engine read the printed characters correctly? Independent
   * of whether the reading makes financial sense. */
  ocrConfidence: number;
  /** Did FDH-5 correctly interpret which field is which (date vs amount vs
   * balance)? Independent of OCR character accuracy. */
  extractionConfidence: number;
  /** Would R8 be able to classify this row at all, given what was
   * extracted? A property of a LATER stage, never conflated backward into
   * this one. */
  classificationConfidence: number;
  /** A STATE, not a score — set by `bank-csv/reconciliation.ts`'s existing,
   * reused engine (spec 47-48: reconciliation is the independent financial
   * backstop no confidence score, however high, may override). */
  reconciliationStatus: 'not_available' | 'pending' | 'reconciled' | 'failed' | 'user_accepted_exception';
}
