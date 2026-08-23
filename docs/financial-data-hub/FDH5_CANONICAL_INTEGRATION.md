# FDH5_CANONICAL_INTEGRATION

## No second canonical transaction table (spec 38, 136)

PDF transactions are written into the SAME `fdh_transactions` table CSV transactions use, via the same `.insert()` shape `bankCsvProcessingService.ts` already established, in `bankPdfProcessingService.ts` — identical columns: `transaction_date`, `description_raw`/`description_clean`, `amount_original`, `credit_debit`, `economic_transaction_type` (`'unknown'` until R8 runs), `source_reference`, `source_page` (new use of an FDH-1 column FDH-5 is the first writer of), `source_row`, `extraction_confidence`, `classification_method` (`'unclassified'`), `source_row_hash`, `economic_fingerprint`, `economic_fingerprint_version`, `dedup_status`, `balance_after`, `transaction_type_hint`. No `pdf_transactions` table exists anywhere in this codebase.

## Direction discipline (spec 39)

`normalizePdfRow()` sets `credit_debit` from the row's OWN sign/DR-CR marker only — never from any assumption about what the transaction economically means. `economic_transaction_type` is always written as `'unknown'` by FDH-5's own insert (identical to the CSV path) and is only ever changed later by R8. `CREDIT != INCOME`, `DEBIT != EXPENSE` — enforced by construction (FDH-5 has no code path that writes anything other than `'unknown'` into `economic_transaction_type`), and by `tests/unit/fdh5R8CrossFormatEquivalence.test.ts`'s static check that no FDH-5 source file references `fdh_categories`/`fdh_merchants`/`fdh_classification_rules` or writes a non-`'unknown'` `economic_transaction_type`.

## Monetary precision (spec 40)

Every value FDH-5 persists passes through `bank-csv/amount.ts`'s `parseAmountField()` + `roundToMoneyScale()` — the EXACT same functions R7 uses, never re-implemented. `numeric(20,4)` storage (unchanged FDH-1 schema) receives an already-rounded, already-validated value; no binary floating-point arithmetic occurs anywhere in the FDH-5 codebase (verified by inspection — every arithmetic operation in `bank-pdf/*` either calls into `bank-csv/amount.ts`/`domain/money.ts` or is a pure string/regex operation on already-parsed values).

## Page and row provenance (spec 86-88)

`source_page` (new use, FDH-1 column) and `source_row` (existing use pattern, matches CSV's `sourceRowNumber`) are populated on every PDF-sourced `fdh_transactions` row. `parser_id`/`parser_version_id` are resolved and persisted once adapter detection succeeds (see `bankPdfProcessingService.ts`'s parser-lookup block). Extraction method (`NATIVE_TEXT` — `'ocr'` is never written in this phase) is recorded at the DOCUMENT level via `fdh_statement_uploads.processing_method` (existing FDH-1 column, already includes `'native_text'`/`'ocr'` — no widening needed).

## Idempotent reprocessing (spec 89-90)

`processBankPdfDocument()` follows the EXACT idempotency pattern `processBankCsvDocument()` already established: already-certified documents return their existing summary unchanged (no-op); a document that previously failed partway is cleaned up (`cleanupPriorAttempt`, deletes only THIS document's own `fdh_transactions`/`fdh_reconciliation_results`/`fdh_data_quality_results` rows) before a fresh attempt runs — never layering a second attempt's rows on top of a first attempt's partial ones. Certified: `tests/unit/fdh5FinancialIntegrity.test.ts`'s idempotent-reprocessing test proves two independent extractions of the identical statement produce byte-identical fingerprints.
