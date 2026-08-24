# FDH5_EXTRACTION_CONFIDENCE

## Three independent dimensions, never merged (spec 44)

| Dimension | Where it lives | Populated by |
|---|---|---|
| `extraction_confidence` (per-transaction) | `fdh_transactions.extraction_confidence` (existing FDH-1 column, migration 0047) | `normalizePdfRow()`'s row-level confidence: `1.0` when the numeric tail was found on the row's own date-opening line; `0.9` when it had to be located on a continuation line (a real but rarer, slightly less certain layout) |
| `extraction_confidence` (statement/document-level) | `fdh_statement_uploads.extraction_confidence` (NEW, migration 0070) | `bank-pdf/orchestrator.ts`: mean row confidence, further penalised by any unparseable block (spec 7: never silently dropped from this signal) and by a MIXED_CONTENT document's sparse pages |
| `classification_confidence` | `fdh_transactions.classification_confidence` (existing FDH-1 column) | R8, unchanged — FDH-5 never writes this column; it is left `NULL` until R8's classification run sets it |
| `reconciliation_status` | `fdh_reconciliation_results.status` | `bank-csv/reconciliation.ts`'s unmodified `reconcileBalances()` — a STATE, never a score |

## Low-confidence routing (spec 45)

`PDF_MIN_EXTRACTION_CONFIDENCE = 0.85`. If the statement-level confidence falls below this threshold, the ENTIRE statement fails as `extraction_low_confidence` (error_code) rather than importing a partially-uncertain set of transactions — the safer of the two spec-sanctioned options ("the transaction should become REVIEW_REQUIRED or extraction should fail"). This phase chose the stricter "fail" option for the whole statement rather than a per-row REVIEW_REQUIRED split, because FDH-5's row-level confidence signal (continuation-line penalty) is coarse-grained and a document-wide failure is easier for a user to act on correctly (re-check the source PDF) than a partially-imported statement with some rows silently missing.

## Extraction confidence does NOT override reconciliation (spec 48)

`bank-pdf/orchestrator.ts` computes `statementExtractionConfidence` and `reconciliation` as two entirely independent values from independent code paths (`normalizePdfRow`'s per-row confidence vs. `reconcileBalances`'s balance-chain arithmetic) — neither is ever used as an input to the other. Even a statement whose every row extracted at confidence `1.0` still fails reconciliation if the arithmetic does not close (proven directly by `tests/unit/fdh5FinancialIntegrity.test.ts`'s 0.01-corruption and missing-row negative controls, both of which use rows that normalise perfectly — confidence `1.0` throughout — yet still fail reconciliation).

## OCR confidence

Not populated in this phase — no OCR call exists. See FDH5_OCR_ARCHITECTURE.md's `OcrConfidenceModel` type for the contract a future integration would fill in.
