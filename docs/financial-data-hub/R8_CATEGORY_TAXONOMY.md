# R8 — Category Taxonomy Reconciliation

## 1. Two deliberately separate taxonomies (confirmed, not merged)

| | `master_financial_items` (manual Input Data) | `fdh_categories`/`fdh_subcategories` (FDH-2) |
|---|---|---|
| Owner | Input Data / Income / Expenses / Financial Health / Forecasting | Financial Data Hub |
| Key | `item_key` (per `category` in `income\|expense\|asset\|liability\|investment\|retirement\|insurance`) | `category_key`/`subcategory_key` |
| Rows | Per-household manual entries (`income_sources`, `expense_items`, ...) | 25 categories / 295 subcategories, service-role-seeded, RLS-locked against authenticated write |
| Written by | The user, directly, through Input Data forms | Only a migration/seed path — never a user, never R8's engine (R8 only ever sets a transaction's `category_id`/`subcategory_id` FK, never inserts a new category row) |

R8 classifies bank transactions **exclusively** against the FDH-2 taxonomy.
It never reads or writes `master_financial_items` or any manual register
table (`income_sources`, `expense_items`, `assets`, `liabilities`,
`investments`, `retirement_accounts`, `insurance_policies` —
`FHIP_PROTECTED_INPUT_TABLES`, enforced by `tests/unit/fdh1Isolation.test.ts`,
unchanged by this release).

## 2. The forward-looking bridge — still not wired

`fdh_categories.fhip_mapping_key` (added FDH-1, `0045`) exists as
metadata-only forward reference for a not-yet-built "FDH Input Data
Bridge." R8 does not read it, does not write it, and does not build any
publishing path from FDH classification into the manual registers — this
remains a documented interface for a future, separately-authorised release
(spec section 55).

## 3. Economic-type vs category

`fdh_categories.economic_type` (an `FdhEconomicTransactionType`, e.g.
`'expense'`) is the source of truth `economicTypeEngine.ts` uses to derive
a transaction's `economic_transaction_type` whenever a category is resolved
via merchant match or a `classify` rule action that sets `category_id`
without also explicitly setting `economic_transaction_type` — a rule's own
explicit `economic_transaction_type`, when present, always wins over the
category's default (a rule author can deliberately classify a transaction
as, say, `fee` even inside a category whose default economic type is
`expense`).

## 4. No category duplication risk introduced

R8 adds zero rows to `fdh_categories`/`fdh_subcategories`. The
duplicate-alias-style risk the original spec worried about (`body_
corporate` vs `strata_fees`) was already FDH-2's concern and is unchanged —
R8 consumes the existing `category_key`/`subcategory_key` machine keys
exclusively; no code path in R8 ever branches on a category's
`display_name`.
