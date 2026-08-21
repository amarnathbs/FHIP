# Chunk 3b — Assets/Investments/Retirement Taxonomy Mapping

Old->new catalogue mapping for the "FHIP — Assets, Investments & Retirement"
spec ("Spec 2") §6 format, covering every item AR-0's discovery doc
(`docs/app-review-2026-08/AR0_DISCOVERY_AND_BASELINE.md` §3.6) flagged.
Implemented by `supabase/migrations/0038_taxonomy_consolidation_deprecation.sql`
and `0039_retirement_contributions_backfill.sql`, off Chunk 3a's canonical
schema (`0033`-`0037`). Real-DEV-data evidence for every row below is in
`docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md`.

**Prerequisite shipped in this same commit**: `components/grid/
FinancialDataGrid.tsx`'s orphaned-`master_item_key` gap is fixed (see
`lib/grid/rowMerge.ts`, `tests/unit/rowMerge.test.ts`) — every deprecation
below (and Chunk 1's withheld migration `0031`) is now safe to apply: a
saved row whose key points at a deprecated item renders as a clearly-marked
"Archived item", not silently.

**Row-migration discipline used throughout**: per this migration's own
constraints, no user-owned row is ever deleted, moved between tables, or
edited beyond the two narrow same-table relabels in rows 26-27 below.
Deprecating a catalogue item only changes which module a *new* tick funnels
into; a user's already-saved row keeps counting toward whichever table's
total it always has (`assets`/`investments`/`retirement_accounts` are
summed independently by table in `lib/engines/dashboard.ts`, not by
catalogue `is_active`), so Net Worth is invariant. See the audit doc's
"why no physical/table-level migration" note for the full reasoning.

| # | Existing Module | Existing Item | New Canonical Module | Canonical Item | Migration Action |
|---|---|---|---|---|---|
| 1 | Assets | `term_deposits` | Investments | `term_deposits` | Deprecate Assets-side (0038) |
| 2 | Assets | `cryptocurrency` | Investments | `cryptocurrency` | Deprecate Assets-side (0038) |
| 3 | Assets | `shares` | Investments | `shares` | Deprecate Assets-side (0038) |
| 4 | Assets | `etfs` | Investments | `etfs` | Deprecate Assets-side (0038) |
| 5 | Assets | `managed_funds` | Investments | `managed_funds` | Deprecate Assets-side (0038) |
| 6 | Assets | `bonds` | Investments | `bonds` | Deprecate Assets-side (0038) |
| 7 | Assets | `private_equity` | Investments | `private_equity` | Deprecate Assets-side (0038) |
| 8 | Assets | `commercial_property` | Investments | `commercial_property` | Deprecate Assets-side (0038) |
| 9 | Assets | `gold` | **Both stay active** | `asset.gold` (personal) / `investment.gold` (investment) | **No action** — Chunk 3a's migration `0034` already gave both rows a `purpose_dimension` (`personal`/`investment`), the correct handling per Spec 2 §26. A flat deprecation would destroy that distinction. |
| 10 | Assets | `silver` | **Both stay active** | `asset.silver` (personal) / `investment.silver` (investment) | **No action** — same reasoning as gold. |
| 11 | Assets | `industry_super` | Retirement | `industry_super` | Deprecate Assets-side (0038) |
| 12 | Assets | `retail_super` | Retirement | `retail_super` | Deprecate Assets-side (0038) |
| 13 | Assets | `defined_benefit` | Retirement | `defined_benefit` | Deprecate Assets-side (0038) |
| 14 | Assets + Investments | `smsf_balance` + `smsf_investments` | Retirement | `smsf` | Deprecate both non-Retirement sides (0038) — the 3-way overlap, most severe single item |
| 15 | Assets | `business_ownership` | Investments | `business_investment` | Deprecate Assets-side (0038) |
| 16 | Assets | `partnership_interest` | Investments | `partnership_investment` | Deprecate Assets-side (0038) |
| 17 | Assets | `trust_assets` | Investments | `trust_investment` | Deprecate Assets-side (0038) |
| 18 | Assets | `investment_property` | Investments | `property` | Deprecate Assets-side (0038) |
| 19 | Assets | `collectables` (misspelling) | Assets | `collectibles` | **Already done** — Chunk 1's migration `0031`. Confirmed consistent with this mapping; not repeated here. |
| 20 | Investments | `high_interest_savings` | Assets | `savings_account` | Deprecate Investments-side (0038) — **reversed direction**: Assets is canonical here (cash accounts belong in Assets per Spec 2's explicit rule) |
| 21 | Investments | `education_fund` | *(Goal, not an asset class)* | — | Deprecate as standalone catalogue item (0038); existing rows flagged `needs_reclassification`, not guessed — see audit doc |
| 22 | Investments | `children_investment` | *(Goal, not an asset class)* | — | Same as `education_fund` |
| 23 | Retirement | `employer_contributions` | *(contribution flow, not a balance)* | `retirement_contributions.contribution_type = 'employer_contributions'` | Deprecate catalogue item (0038); backfill real rows with confident evidence into `retirement_contributions` (0039); `dashboard.ts` excludes from `totalRetirement` unconditionally |
| 24 | Retirement | `salary_sacrifice` | *(contribution flow)* | `retirement_contributions.contribution_type = 'salary_sacrifice'` | Same pattern as #23 |
| 25 | Retirement | `personal_concessional` | *(contribution flow)* | `retirement_contributions.contribution_type = 'personal_concessional'` | Same pattern as #23 |
| 26 | Retirement | `non_concessional` | *(contribution flow)* | `retirement_contributions.contribution_type = 'non_concessional'` | Same pattern as #23 |
| 27 | Retirement | `government_co_contribution` | *(contribution flow)* | `retirement_contributions.contribution_type = 'government_co_contribution'` | Same pattern as #23 |
| 28 | Retirement | `spouse_contribution` | *(contribution flow/relationship)* | `retirement_contributions.contribution_type = 'spouse_contribution'`, `contributor = 'spouse'` | Same pattern as #23 |
| 29 | Retirement | `allocated_pension` | Retirement | `account_based_pension` | **Same-table relabel** — `update retirement_accounts set master_item_key = 'account_based_pension' where master_item_key = 'allocated_pension'` (0038), then deprecate the old catalogue item. Zero external code dependency on either key (grep-verified) |
| 30 | Retirement | `retirement_savings` | Retirement | `other_retirement_assets` | **Same-table relabel**, same mechanism as #29 |

## Investigated and deliberately left unchanged (with reasons)

| Item | Finding | Action |
|---|---|---|
| `asset.holiday_home`, `asset.vacant_land`, `asset.farm` | Genuinely ambiguous personal-vs-investment purpose; Chunk 3a's `0034` already left `purpose_dimension` null for these three, with no existing signal to disambiguate at the catalogue level. | No module move. A future phase could add a per-user-row purpose toggle. |
| `asset.intellectual_property` | Low-priority ambiguous case (business asset?), per discovery doc. | Left as-is. |
| `investment.cash_investments` | Discovery doc flags this as Class D, conceptually indistinguishable from `asset.savings_account` — same underlying issue as `high_interest_savings` (#20 above). | **Not enumerated in this sub-chunk's explicit item list (item 4 of the dispatch)** — deliberately left untouched to stay within scope rather than silently expanding it. Flagged here for a future consolidation pass alongside `high_interest_savings`. |
| `retirement.transition_to_retirement` | Chunk 3a confirmed this is a genuinely distinct decumulation product (accessible while still working, different tax/contribution treatment) — not a duplicate of `allocated_pension`/`account_based_pension`. | No consolidation. |
| `retirement.annuity` | Distinct decumulation product, complementary (not duplicate) with `income.annuity_income`. | No action — correct as-is. |
| `retirement.overseas_pension`, `retirement.other_retirement_assets` | Correct generic catch-alls. | No action. |
| `retirement.smsf`, `industry_super`, `retail_super`, `defined_benefit`, `account_based_pension` | Canonical destinations for the moves above. | Already active, untouched. |

## The 2 "possible duplicate" rows found in real DEV data (not auto-consolidated)

Per Spec 2 §54-57's discipline ("never by value alone... deterministic
duplicate needs strong matching evidence"), the audit script found exactly
2 cross-module pairs (both already known from AR-0's discovery pass) where
the SAME user has a row under both a deprecated key and its canonical
counterpart. Neither met the deterministic-duplicate bar (value+currency
matched, but `created_at` timestamps were not close enough to support a
"same data-entry session" inference) — **both rows are preserved
unmodified**, flagged for manual review:

- User `af048889-efb0-4d27-8f53-5fa6c202cd7c`: `asset.term_deposits` +
  `investment.term_deposits`.
- User `5e5aa253-18f2-4190-8eef-4c1fee42a26e`: `asset.commercial_property` +
  `investment.commercial_property`.

See `docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md` for the full
evidence and the Net Worth reconciliation this produces.

## Out-of-scope, disclosed findings from this pass (not part of this sub-chunk)

- `lib/services/forecastData.ts` and `lib/services/twinData.ts` both sum
  `retirement_accounts.current_balance` the same unfiltered way
  `dashboard.ts` used to — i.e. the same Class-F phantom-balance defect this
  sub-chunk fixes in `dashboard.ts` likely also affects Forecasting and the
  Financial Twin's retirement figures. Confirmed present via grep
  (`current_balance` summed with no `master_item_key` exclusion in both
  files), not fixed here — this sub-chunk's explicit scope is `dashboard.ts`
  only, and Forecasting/Financial Twin are distinct modules outside this
  taxonomy-consolidation sub-chunk's boundary. Flagged for a follow-up pass.
