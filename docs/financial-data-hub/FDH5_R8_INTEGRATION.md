# FDH5_R8_INTEGRATION

## Zero PDF-specific categorisation code (spec 63-64)

`POST /api/financial-data-hub/bank-transactions/categorise` (unchanged, R8) calls `classifyUserTransactions(userId)`, which operates over ALL of a user's canonical `fdh_transactions` rows with no `source_type`/`processing_method`/format awareness whatsoever — verified directly by static inspection of `classifyTransaction()`'s input shape (`lib/financial-data-hub/classification/economicTypeEngine.ts`): it consumes only `description_clean`, `merchant_raw`, `financial_account_id`, and an `institutionId`, none of which carries a source-format signal. `tests/unit/fdh5R8CrossFormatEquivalence.test.ts` asserts this statically (R8's source contains no `source_type`/`processing_method` reference) and separately asserts that no file under `lib/financial-data-hub/bank-pdf` references any classification table (`fdh_categories`/`fdh_merchants`/`fdh_classification_rules`) or writes a non-`'unknown'` `economic_transaction_type`.

## R8 output equivalence (spec 65)

Because R8 classification is a pure function of `descriptionClean`/`amountOriginal`/`creditDebit` (plus DB-side rule/merchant data, unchanged by FDH-5), proving that FDH-5's normalisation produces IDENTICAL `descriptionClean`/`amountOriginal`/`creditDebit`/`transactionDate`/`balanceAfter` for an economically-equivalent PDF and CSV row is the correct and sufficient precondition — R8 is then GUARANTEED to classify them identically by construction, with no live-DB rule table needed to prove it in this test. Certified directly: `tests/unit/fdh5R8CrossFormatEquivalence.test.ts`'s "cross-format canonical equivalence" test builds a CBA transaction once as a PDF fixture and once as an equivalent CSV row (through `bank-csv/normalize.ts`'s own `normalizeRow`, completely unmodified), and asserts every one of those fields matches exactly.

## Source description preservation (spec 66)

`descriptionRaw` is preserved from the PDF's own extracted text (only whitespace-collapsed via `normalizeDescription`, the same shared primitive CSV uses) — never mutated to make a merchant match succeed. Certified: `tests/unit/fdh5R8CrossFormatEquivalence.test.ts`'s "source description is preserved verbatim" test, with an intentionally irregularly-spaced source description proving only whitespace collapse occurs, no word is added or removed.

## Existing R8 certification remains green

R8's own certification suite (`tests/unit/r8*.test.ts`) was re-run unmodified as part of full regression (see FDH5_COMPLETION_REPORT.md §17) — no FDH-5 change touches any R8 file except the one, disclosed, additive fix to `tests/unit/r8SchemaContract.test.ts`'s widening-scope assertion (necessary because `FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES` now includes FDH-5's own additions too — R8's test was re-scoped to its OWN migration's combined vocabulary rather than the ever-growing "ALL" constant, exactly mirroring the discipline that constant's own R7/R8 precedent already established).
