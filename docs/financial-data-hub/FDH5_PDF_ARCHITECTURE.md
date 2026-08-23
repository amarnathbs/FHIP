# FDH5_PDF_ARCHITECTURE

## Pipeline (spec section 13)

```
Private PDF (FDH-3 storage)
  -> download bytes (server-side only)
  -> classifyPdf() [bank-pdf/classification.ts]
       -> TEXT_NATIVE | IMAGE_ONLY | MIXED_CONTENT | ENCRYPTED | CORRUPT | UNSUPPORTED
  -> (TEXT_NATIVE/MIXED_CONTENT only) detectPdfBankAdapter() [bank-pdf/detection.ts]
       -> DETECTED | AMBIGUOUS | UNSUPPORTED_LAYOUT
  -> extractPdfStatementMetadata() [bank-pdf/metadata.ts]
  -> flattenPdfLines() + reconstructRows() [bank-pdf/rowReconstruction.ts]
  -> normalizePdfRow() per row [bank-pdf/normalize.ts]  (reuses bank-csv primitives)
  -> computeSourceRowHash / computeEconomicFingerprint / decideDedup  [bank-csv/* — UNCHANGED]
  -> reconcileBalances / computeDateCoverage             [bank-csv/* — UNCHANGED]
  -> decidePdfCertification() [bank-pdf/orchestrator.ts] (wraps bank-csv's decideCertification unchanged)
  -> persistence (bankPdfProcessingService.ts) -> fdh_transactions (SAME table CSV uses)
  -> POST /bank-transactions/categorise (R8, unchanged, format-agnostic)
```

OCR is a documented fallback CONTRACT (`bank-pdf/ocr.ts`) reached only when classification returns `IMAGE_ONLY`/sparse `MIXED_CONTENT`; no OCR provider is called in this phase (spec 14, 41 — "native text first", "OCR is a fallback, not the default"; see FDH5_OCR_ARCHITECTURE.md for the scope decision).

## Module map

```
lib/financial-data-hub/bank-pdf/
  constants.ts        page/row/text-size ceilings, min extraction confidence, rate-limit ceiling
  textExtraction.ts    thin pdf-parse wrapper, page-segmented (new — see below)
  classification.ts    structural classification, wraps textExtraction
  detection.ts          adapter/layout detection (mirrors bank-csv/detection.ts)
  rowReconstruction.ts  line-stream -> transaction blocks -> rows
  metadata.ts            opening/closing balance, masked account, period extraction
  normalize.ts            ReconstructedRow -> NormalizedTransactionCandidate (bank-csv-identical shape)
  orchestrator.ts          pure pipeline; imports bank-csv/{fingerprint,dedup,reconciliation,orchestrator} UNCHANGED
  ocr.ts                    OCR fallback contract/types (architecture only, no live call)
  password.ts                rate-limit decision logic (no password value ever touches this file's own state)
  adapters/
    types.ts   PdfBankAdapter contract + scoreTextAgainstSignature
    registry.ts  PDF_BANK_ADAPTER_REGISTRY (8 priority-wave adapters)
    auAdapters.ts / inAdapters.ts
```

## Why a new `textExtraction.ts` rather than reusing Investment Intelligence R2's `extractPdfText`

Both use `pdf-parse`; no second dependency is introduced (spec 123). R2's function collapses a document to one concatenated string + a page COUNT — sufficient for its own balance-sheet-style CAS reading, insufficient for FDH-5, which needs each page's text SEPARATELY for page provenance (spec 87), page-break transaction handling (spec 34), and per-page classification signal (spec 15's MIXED_CONTENT). Rather than change R2's already-certified return contract for a caller it was never designed for, FDH-5 owns a second, narrow wrapper mirroring R2's PROVEN approach (same library, same `PasswordException` disambiguation rule, same "never fabricate text" principle) rather than re-deriving it from scratch.

## Row reconstruction strategy — a documented scope decision

`pdf-parse` exposes a vector-geometry `getTable()` (ruled-line ¬detection). FDH-5 evaluated it and did **not** build certification around it in this phase: many real bank-statement PDFs are not ruled with vector-drawn borders at all (column alignment achieved by text positioning alone), and a half-tested second extraction code path is a worse outcome than one well-tested one. The certified strategy is line-stream reconstruction: a transaction block opens at a line matching the adapter's `dateLineRegex` and continues (across page boundaries) through non-header/footer lines until the next date line; the block's numeric tail (amount + balance) is located by regex from whichever line in the block carries it — see `rowReconstruction.ts`'s own header comment for the full reasoning and `FDH5_NATIVE_TEXT_EXTRACTION.md` for certification evidence.

## Known `pdf-parse` constraint discovered during certification

`pdf-parse`'s own documented contract: a `Uint8Array` passed as `data` "will generally be TRANSFERRED to the worker thread". Concretely, the SAME buffer instance cannot be parsed twice concurrently — a second concurrent call against the identical array produces a `pages: null` result, not an error. This is not a production hazard (`downloadDocumentObject` returns a fresh buffer per call; FDH-5 never re-parses one in-memory buffer twice within a request), but it was discovered live by an idempotency test in `tests/unit/fdh5FinancialIntegrity.test.ts` that originally ran two concurrent extractions against one shared buffer — the test was corrected to use two independent buffer copies (matching what a real reprocessing attempt actually does), and this constraint is recorded here so nobody rediscovers it as a mystery.
