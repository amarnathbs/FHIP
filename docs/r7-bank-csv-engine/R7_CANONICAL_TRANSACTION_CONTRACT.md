# R7 — Canonical Transaction Contract

## 1. The canonical row (`fdh_transactions`, as widened by migration 0064)

| Field | Source | Notes |
|---|---|---|
| `transaction_date` / `posting_date` / `value_date` | Adapter/mapping-proven date format | Never collapsed; whichever the source lacks stays null |
| `description_raw` | Verbatim source cell | Immutable evidence, purgeable per FDH-1 lifecycle |
| `description_clean` | `normalizeDescription()` | NFKC, trimmed, whitespace-collapsed; reference numbers preserved |
| `amount_original` | `parseAmountField()` + `credit_debit` | Strictly positive magnitude; direction is the separate `credit_debit` column — **this satisfies spec §25's "one canonical sign convention" using FDH-1's existing magnitude+direction encoding rather than inventing a second `signed_amount` column** |
| `credit_debit` | Adapter amount-convention logic | `credit` \| `debit`, never conflated with economic meaning |
| `balance_after` | Source balance column, when present | Row-level running balance |
| `source_row` | 1-based row index in the parsed data | |
| `source_row_hash` | `computeSourceRowHash()` | Layer-2 dedup (statement + row + raw values) |
| `economic_fingerprint` / `_version` | `computeEconomicFingerprint()` | Layer-3 dedup, account-scoped, batch-independent |
| `dedup_status` | `decideDedup()` | `unique` / `duplicate_confirmed` / `duplicate_candidate` / `user_confirmed_distinct` / `user_confirmed_duplicate` |
| `transaction_type_hint` | Deterministic substring rules | `debit`/`credit`/`transfer_candidate`/`fee_candidate`/`interest_candidate`/`atm_candidate`/`card_payment_candidate`/`direct_debit_candidate`/`salary_candidate`/`investment_transfer_candidate`/`unknown` |
| `economic_transaction_type` | Always `'unknown'` at R7 ingestion | R7 does not classify — see §6 |
| `classification_method` | Always `'unclassified'` at R7 ingestion | |
| `extraction_confidence` | `1` (CSV text extraction is exact — no OCR/AI uncertainty in R7) | |
| `parser_version_id` | FK → `fdh_parser_versions` | Which adapter/mapping produced this row |
| `mapping_template_id` | FK → `fdh_csv_mapping_templates`, nullable | Set only when a generic mapping (not an adapter) was used |

## 2. `error_code` / review-vocabulary reuse (no widening needed)

R7 deliberately reuses the FROZEN FDH-1 vocabularies rather than widening them:

| R7 situation | `fdh_statement_uploads.error_code` (frozen, 0046) | `fdh_review_items.review_type` (frozen, 0048) |
|---|---|---|
| Ambiguous/unsupported format | `layout_unsupported` | n/a — `detection_status` carries this |
| Malformed rows beyond safe recovery | `data_validation_failed` | n/a |
| Parse/normalisation failure | `extraction_failed` | n/a |
| Duplicate candidates pending | n/a | `possible_duplicate` (exact vocabulary match) |
| Reconciliation failed | n/a | `reconciliation_failure` (exact vocabulary match) |
| Account identity ambiguous | n/a | `other` + free-text `title_code = 'bank_csv.account_identity_ambiguous'` |

`title_code` is unconstrained text (not a closed DB vocabulary), so R7-specific review reasons are expressed there without touching the frozen `review_type` check constraint. See migration 0064's header comment for the full mapping rationale.

## 3. Amount canonicalisation — the three source shapes

| `amount_convention` | Source shape | Direction derivation |
|---|---|---|
| `single_signed` | One `Amount` column, sign or parentheses indicate direction | Negative/parenthesised → debit; positive → credit |
| `debit_credit_columns` | Separate `Debit`/`Credit` columns | Whichever column is non-zero; both non-zero → `ambiguous_direction` (rejected) |
| `dr_cr_indicator` | One `Amount` + one `Dr/Cr` column | `DR`/`D`/`DEBIT` → debit; `CR`/`C`/`CREDIT` → credit; anything else → `ambiguous_direction` |

Money text parsing (`amount.ts`) strips currency symbols (`$₹€£`) and comma thousands-separators, accepts parenthesised negatives, and does the ONE `Number()` call on an already-clean decimal string — no intermediate floating-point arithmetic on the parsed value before it reaches `lib/financial-data-hub/domain/money.ts`'s minor-unit-exact primitives.

## 4. Certification-status decision table (`decideCertification()`)

| Condition | `certification_status` |
|---|---|
| Detection `invalid` / `unsupported` | `rejected` |
| Detection `ambiguous` / `manual_mapping_required` | `review_required` |
| `parsedRowCount ≠ declaredRowCount`, or any row rejected | `partial` (never silently certified — spec §46/91) |
| Account identity ambiguous | `review_required` |
| Any duplicate candidate outstanding | `review_required` |
| Reconciliation `failed` | `review_required` |
| None of the above | `certified` |

`certification_status` is a **new** column, deliberately independent of the FDH-1 `processing_status` lifecycle column (which tracks workflow position, not certification conclusion) — see `R7_BANK_CSV_ARCHITECTURE.md` §3.

## 5. Classification-ready contract proof (spec §85)

A later classifier needs, without touching the raw CSV: `description_raw`, `description_clean`, `amount_original` + `credit_debit`, `transaction_date`, `currency_original`, `transaction_type_hint`, `source_reference`. Every certified `fdh_transactions` row carries all seven — proven directly by certification cases R7-TC041-R7-TC065 (normalisation) and by the fact that `bank-csv/orchestrator.ts` never reads back the original file after the initial parse.

## 6. What R7 explicitly does NOT do

- Does not set `economic_transaction_type` to anything but `unknown`.
- Does not set `classification_method` to anything but `unclassified`.
- Does not create `category_id`/`subcategory_id`/`merchant_id`.
- Does not create any `ii_*` row for an `investment_transfer_candidate` hint (spec §86, proven by R7-TC157).
- Does not modify Assets/Liabilities/Investments/Retirement/Goals/Net Worth/R6 tax tables (no R7 file references any of `FHIP_PROTECTED_INPUT_TABLES` or `II_OWNED_CANONICAL_ENTITIES`).
