# FDH2_CATEGORY_TAXONOMY

## 1. Structure

`Economic Type -> Top-Level Category -> Subcategory`, matching the
specification's hierarchy exactly. Economic type is FDH-1's existing
`economic_transaction_type` enum (13 values, unchanged — see
`fdh_economic_transaction_types` for descriptive metadata added by FDH-2).
Category and subcategory are `fdh_categories`/`fdh_subcategories`
(FDH-1 schema, FDH-2 populated + extended).

**25 top-level categories, 121 subcategories.** See
`data/financial-data-hub/categories.mjs` and `subcategories.mjs` for the
full authored list; `FDH2_MASTER_DATA_MANIFEST.md` for the live counts.

## 2. A structural decision: one economic_type per category, not per family

The specification's "Special Financial Classifications" family (own-account
transfer, credit-card payment, loan principal, investment purchase/sale,
super/EPF/NPS contribution, cash withdrawal, refund/reversal, unknown) is
implemented as **nine separate top-level categories**, not nine
subcategories of one "Financial" category. Reason: `fdh_categories.
economic_type` is a single required value per category row (FDH-1 schema),
and these nine concepts each need a genuinely different one (`transfer`,
`transfer`, `debt_principal`, `asset_purchase`, `asset_sale`, `investment`,
`cash_withdrawal`, `refund`, `unknown`). Forcing them under one parent would
either violate the single-economic-type-per-category rule or require adding
a second `economic_type` column to `fdh_subcategories` — a schema change
this session judged unnecessary against the "extend FDH-1 only where
genuinely required" governance rule. This is a **structural change vs the
literal wording of the specification's family list**, documented here as
required.

Two members of the FDH-1-approved `economic_transaction_type` enum were
explicitly considered and NOT added — `liability_settlement` and
`retirement_contribution` — because FDH-1 already made and recorded that
decision (`FDH1_DOMAIN_MODEL.md` section 4). FDH-2 honours it: a credit-card
payment uses `economic_type = 'transfer'` (documented as a liability
settlement via its category/subcategory name, not via a new enum value), and
a super/EPF/NPS contribution uses `economic_type = 'investment'`.

`tax_reporting_flag` (FDH-1's existing boolean) fulfils the specification's
"tax_reporting_relevance — informational only" requirement without a
rename — it is a plain flag, never a "this is deductible" assertion.
`version` (FDH-1's existing int) serves as `taxonomy_version` without a
rename, for the same additive-only reason.

## 3. Country applicability

Every category/subcategory carries `country_applicability` (`char(2)[]`,
FDH-1 schema). All 25 categories in this pass are seeded `['AU','IN']` —
FDH-2 found no category-level concept that applies to only one country
(country-specific TERMINOLOGY, e.g. "council rates" vs "property tax", is
handled at the subcategory description level, not by excluding a country).
Two subcategories ARE country-restricted: `retirement_contribution.
superannuation_contribution` (`AU` only) and
`retirement_contribution.epf_contribution` /
`retirement_contribution.nps_contribution` (`IN` only) — a real
country-specific concept, not a display-label difference, so exclusion is
correct here.

## 4. Essential / discretionary and fixed / variable

`FDH_ESSENTIAL_DISCRETIONARY` was widened (migration `0050`) to add
`user_dependent`, alongside FDH-1's `essential`/`discretionary`/`mixed`/
`not_applicable`. Used for genuinely context-dependent families:
`education` and `family` are `user_dependent` at the category level (a
household's tuition/childcare mix varies too much for one bucket);
`food`/`transport` are `mixed` (groceries vs restaurants; fuel vs rideshare)
with several individual subcategories carrying their own override (e.g.
`food.groceries = essential`, `food.restaurants = discretionary`, both
under the `mixed` parent — a subcategory's `null` value means "inherit the
parent's value").

`fixed_variable` (new column, `fixed`/`variable`/`semi_variable`/
`user_dependent`/`not_applicable`) is populated at both category and
subcategory level using the same inheritance rule. Both fields are
explicitly documented as **metadata only, never classification logic** —
nothing in FDH-2 reads them to make a decision.

## 5. Versioning and retirement

`effective_from`/`deprecated_at`/`replacement_key` (category) and
`replacement_subcategory_id` (subcategory) are new nullable columns. A
category is never deleted; it is retired via `active = false` plus
`deprecated_at`, optionally naming a `replacement_key`. Three database
constraints enforce this is not just a convention:
`chk_fdh_categories_deprecation` (a deprecated category cannot be active),
`chk_fdh_categories_replacement_needs_deprecation` (a replacement can only
be named on an already-deprecated row), and
`chk_fdh_categories_no_self_replacement`. FDH-2 seeds zero deprecated
categories — this machinery exists for future governance, not because
anything needed retiring yet.

## 6. FHIP input-mapping keys

Every category and every subcategory carries a `fhip_mapping_key` — a
durable semantic identifier (`expense.groceries`, `income.salary_wages`,
`transfer.credit_card_payment`, ...), never a raw database column name.
FDH-2 populates these keys only; wiring them into the actual FHIP Input
Data registers (`income_sources`/`expense_items`/`assets`/`liabilities`/
`investments`/`retirement_accounts`/`insurance_policies`) is explicitly
FDH-15's job. No FDH-2 code reads or writes any of those seven tables — see
`tests/unit/fdh2SchemaContract.test.ts`'s protected-table check.

## 7. AI cannot invent a production category

There is no INSERT/UPDATE/DELETE policy on `fdh_categories` or
`fdh_subcategories` for `anon`/`authenticated` (RLS, migration `0045`,
unchanged by FDH-2). A new category can only ever be added by a
service-role-authenticated migration/seed path — structurally, not by
convention. `FDH2_RLS_SECURITY.md` documents the live negative-control proof
of this.
