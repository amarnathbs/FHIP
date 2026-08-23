# FDH-4 — Transaction Normalization

Reused unmodified from R7 (`lib/financial-data-hub/bank-csv/normalize.ts`). Full field-level design is documented in `docs/r7-bank-csv-engine/R7_CANONICAL_TRANSACTION_CONTRACT.md`; this page records only what FDH-4 verified and what changed.

## Canonical field coverage (`fdh_transactions`)

| Field | Populated by | Notes |
|---|---|---|
| `transaction_date` | `normalizeRow()` via `parseDateWithFormat(dateRaw, rowFormat.dateFormat)` | Adapter-declared format only — never inferred per-row (spec 14) |
| `posting_date`, `value_date` | Same, when the adapter declares those column roles | Null when the format doesn't carry them (e.g. ANZ/Macquarie/Axis/Kotak fixtures use transaction date only) |
| `description_raw` | Verbatim source cell | Preserved for provenance (spec 36) |
| `description_clean` | `normalizeDescription()` | Deterministic (whitespace/case normalisation), not a classification |
| `amount_original` | `parseAmountField()` → `domain/money.ts` integer-minor-unit arithmetic | No `parseFloat` financial arithmetic anywhere (verified: zero matches, this session) |
| `credit_debit` | Adapter's `amountConvention` (`single_signed` / `debit_credit_columns` / `dr_cr_indicator`) | All 4 new FDH-4 adapters use `debit_credit_columns` — the two most common shapes among the priority-wave banks not yet covered |
| `balance_after` | Adapter's `balance` column role, when present | `NULL` when absent (Macquarie) — never fabricated |
| `currency_original` | Passed in from account-scoped upload metadata (AUD for AU adapters, INR for IN adapters in this session's fixtures) | Currency is not inferred from country when it contradicts the source — unchanged R7 behaviour |
| `source_reference` | Adapter's `reference` column role, when present | ANZ/Macquarie have it (Serial / Cheque-Reference Number); the Macquarie/ANZ/Axis/Kotak fixtures exercise both presence and absence |
| `source_row`, `source_row_hash` | Row index + `computeSourceRowHash()` | Provenance, unchanged |
| `institution_id` | Resolved from FDH-2 master data by the upload's declared institution | FDH-4 adds no new institution rows — reuses the 4 existing FDH-2 entries (`anz`, `macquarie_bank`, `axis_bank`, `kotak_mahindra_bank`) that were previously `master_only` |
| `parser_version_id` | `fdh_parser_versions` FK, resolved live by `parser_key` | The 4 new adapters' governance rows are seeded by migration `0066` — **not yet live** (see completion report residuals); until applied, only the 6 R7 adapters can populate this live |
| `extraction_confidence` | Always `1` at ingestion | Unchanged |

## New-adapter verification (this session)

- Independent Python oracle (`scripts/r7_oracle_compare.ts` → `r7_independent_bank_csv_oracle.py`): **327/327 comparisons, 0 discrepancies**, across all 10 fixtures (6 R7 + 4 FDH-4) — date, amount, direction, `description_clean`, reference, `balance_after` checked field-by-field per row.
- `tests/unit/fdh4AdapterCoverage.test.ts`: 20 cases covering detection + reconciliation for the 4 new adapters.

## What FDH-4 did NOT touch

`normalize.ts` itself, the `RowFormat`/`NormalizedTransactionCandidate` types, `adapterToRowFormat()`, `mappingToRowFormat()`, and the manual-mapping path are all unmodified R7 code. No new normalization logic was written — the 4 new adapters slot into the existing `debit_credit_columns` convention path exactly as CBA/NAB/HDFC/ICICI already do.

## Scope boundary held (spec sections 12, 42-43)

No merchant classification, expense/income categorisation, or transfer-matching logic was added. `economic_transaction_type` remains `'unknown'`, `classification_method` remains `'unclassified'` for every transaction FDH-4's new adapters produce — verified directly in the live-DEV certification output (`FDH4-E2E-03`, `certification_status` reflects parsing/reconciliation success only, not economic classification).
