# FDH2_MCC_MAPPING

## 1. Scope

87 MCC codes (`fdh_mcc_master`), drawn from the public ISO 18245 code space
(see `FDH2_RESEARCH_EVIDENCE.md` source `iso18245_mcc_public_reference`),
covering grocery/supermarket, food & beverage, fuel/automotive,
utilities/telecom, transport/travel, health/medical, education, financial
services, government services, retail/merchandise, entertainment/
recreation, professional services and wholesale/business. Each carries
`official_or_public_description` (the standard description),
`normalized_description` (FHIP's concise restatement), `broad_group` (one
of 15 FHIP-defined groups), and `country_relevance` (all 87 are relevant to
both AU and IN — MCC is a global vocabulary, not a jurisdiction).

## 2. An MCC is an input signal, never an absolute classification

Every mapping row (`fdh_mcc_category_map`, 87 rows, one per MCC) carries
`mapping_confidence` (`high`/`medium`/`low`/`context_required`) and
`mapping_type` (`direct`/`broad_group_only`/`ambiguous_unmapped`). Actual
breakdown:

| mapping_type | Count | Meaning |
| --- | --- | --- |
| `direct` | 67 | A specific category (and often subcategory) is confidently assigned |
| `broad_group_only` | 13 | Only a top-level category is assigned; subcategory is deliberately left ambiguous |
| `ambiguous_unmapped` | 7 | No category at all — resolving this MCC requires merchant identity or narrative context |

Counts as of the 2026-08-22 closure-research pass (migration `0057`): MCC
`5531` ("Auto and Home Supply Stores") was downgraded from `direct`/`medium`
(with a `vehicle_maintenance_registration` subcategory) to
`broad_group_only`/`low` with no subcategory, after live verification of the
official description confirmed these stores commonly also sell home
appliances/electronics — a genuinely mixed automotive/shopping purpose the
original `direct` mapping over-specified. This moved one row from `direct`
to `broad_group_only` relative to FDH-2's original counts (68/12/7).

| mapping_confidence | Count |
| --- | --- |
| `high` | 43 |
| `medium` | 24 |
| `low` | 9 |
| `context_required` | 11 |

## 3. Deliberately unresolved MCCs (the "never guess" cases)

Seven MCCs are seeded `ambiguous_unmapped` with `category_id = null`:

- `6012` (Financial Institutions — Merchandise and Services) — could be a
  fee, a transfer, a credit-card payment or an investment funding movement.
- `6051` (Quasi Cash) and `6540` (POS Funding, Non-Financial Institutions) —
  same reasoning.
- `8931` (Accounting/Bookkeeping) and `8111` (Legal Services) — personal vs.
  business spend cannot be told apart by MCC alone.
- `5199`/`5085` (wholesale/industrial-supply codes) — business-context
  dependent.

Four more MCCs are seeded `broad_group_only` **with a category but no
subcategory**, because the code genuinely spans multiple household
subcategories the MCC itself cannot distinguish:

- `4900` (Utilities — Electric, Gas, Water, Sanitary) — electricity vs gas
  vs water cannot be told apart without the specific retailer's identity.
- `4899` (Cable/Satellite/Pay-TV) — a utility pay-TV bundle vs. a
  discretionary streaming subscription; merchant identity resolves this
  (see `FDH2_MERCHANT_MASTER.md`'s streaming-merchant rows).
- `6300` (Insurance Sales/Underwriting/Premiums) — health vs life vs home vs
  vehicle insurance.
- `5399` (Miscellaneous General Merchandise) — a near-universal marketplace
  code.

Every one of these seven+four rows is enforced by the database, not just
convention: `chk_fdh_mcc_map_ambiguous_no_subcategory` rejects a subcategory
on any `ambiguity_flag = true` row, and `chk_fdh_mcc_map_type_consistency`
rejects a category on any `ambiguous_unmapped` row — an attempt to smuggle
false precision into either fails at the database layer, independently
verified by `tests/unit/fdh2Validation.test.ts` and
`scripts/fdh2_certify_master_data.mjs`.

## 4. Resolution is FDH-6's job, not FDH-2's

Every ambiguous/broad-group-only row's `notes` column names exactly what
additional signal (merchant identity, narrative context) a future
classification engine needs. FDH-2 builds no such engine — this table is
the governed input a future one will read.
