# FDH5_OCR_ARCHITECTURE

## Decision: OCR is architecture-only in this phase — no third-party provider is integrated

Spec section 42 requires, before any OCR integration: inspecting existing infrastructure for a provider already in use, and — if none exists — choosing one only after documenting privacy/data-residency/retention/training-data implications. Spec section 43 is explicit: **"If contractual/privacy facts cannot be established: STOP before production integration."**

### Existing infrastructure check

`.env.local` (the only credential source available to this implementation) was inspected directly. No OCR/document-intelligence provider key exists anywhere in this repository — not for Investment Intelligence, not for FDH, not anywhere else (`grep -iE "ocr|azure|aws|textract|google.*vision|document.*intelligence|tesseract"` against `.env.local`: zero matches).

### Why this STOPs here

Selecting and contracting with a new third-party OCR provider is a genuine product/legal decision — a data-processing agreement, a region choice, a retention policy, a training-data opt-out, and Privacy Policy wording all need to be actually established, not invented inside a single implementation session. Doing so without those facts would violate spec 43's STOP condition outright, and spec 137 explicitly disallows using CONDITIONAL PASS to "conceal... unverified OCR claims" — so this is disclosed plainly rather than worked around.

### Candidate providers considered (evaluation only, no selection made)

| Provider | Table extraction | Region options | Notes |
|---|---|---|---|
| Cloud-hosted general OCR/document-intelligence APIs (the major cloud providers all offer one) | Yes, table-aware variants exist | Multi-region, but requires an explicit account/contract this session cannot create | Would need a documented DPA, retention setting, and training-data opt-out before ANY real document could be sent |
| Self-hosted open-source OCR engines | Table support varies, generally weaker than cloud offerings | Fully on-infrastructure (best privacy story) | No current deployment infrastructure for a persistent OCR worker exists in this repository |

No provider is selected. This table exists so a future phase does not have to re-derive the candidate set from nothing.

## What FDH-5 actually builds: the contract

`lib/financial-data-hub/bank-pdf/ocr.ts` defines:
- `determineOcrEligibility(classification)` — routing decision only (`'not_required' | 'eligible_not_available'`), no OCR call.
- `OcrConfidenceModel` — the three-dimension confidence contract spec 44 requires stay independent (`ocrConfidence`, `extractionConfidence`, `classificationConfidence`, plus `reconciliationStatus` as a STATE not a score) — modelled as a TypeScript type for a future integration to fill in, not populated by any code path today.

## What happens to a scanned/image-only statement today

`classifyPdf()` correctly reports `IMAGE_ONLY` (or `MIXED_CONTENT` with sparse pages); `bankPdfProcessingService.ts` maps this to `error_code: 'ocr_required'` and the document is `rejected` — clean, honest, and per spec 7 ("prefer REVIEW_REQUIRED or UNSUPPORTED_FORMAT over importing uncertain financial data") rather than fabricating OCR output. No transaction is ever created from an image-only page.

## Acceptance-criteria disposition (spec 130, "if included")

OCR is genuinely **not included** in this phase's certified scope. The acceptance criteria that only apply "if OCR is included" (provider/security architecture documented — done above; confidence captured — type defined, not populated; low-confidence handling — N/A, no OCR output exists to be low-confidence; financial-corruption negative controls — N/A for the same reason) are honestly marked not-applicable rather than claimed passed. See FDH5_COMPLETION_REPORT.md §7.
