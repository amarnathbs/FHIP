# Chunk 3b — Migration Audit (Spec 2 §54-60)

Read-only dry-run audit against real DEV data (`vqycarelcoijzwlpkpcz`), run
2026-08-21 via `scripts/chunk3bMigrationAudit.mjs` (and its companion
`scripts/chunk3bRetirementContributionsBackfillGenerator.mjs`, which
generated `supabase/migrations/0074_retirement_contributions_backfill.sql`).
Both scripts use the service-role key exactly like every prior phase's
read-only PostgREST scripts (`scripts/importRecommendationsData.mjs` is the
established precedent) — **no `.insert()`/`.update()`/`.delete()` call
exists in either script**; every call is `.select()`. No write of any kind
was made to DEV or production during this pass.

Full raw JSON evidence: written to the session scratchpad
(`chunk3b_audit_output.json`), not committed to the repo (matches this
session's established precedent of not committing one-off evidence dumps).
Every number below was read directly from that output, not summarized from
memory.

## Population

838 active `assets` rows, 717 active `investments` rows, 357 active
`retirement_accounts` rows, 338 active `liabilities` rows, across **206
distinct users** — the same DEV population AR-0's discovery pass measured
(re-confirmed identical counts, so no population drift between passes).

## Spec 2 §59 migration audit table

| Metric | Count | Detail |
|---|---:|---|
| Records before (rows referencing a to-be-deprecated catalogue key) | **171** | 70 in `assets`, 18 in `investments`, 83 in `retirement_accounts` — see the per-key breakdown below |
| Records reclassified (real `master_item_key` UPDATE on the same physical row) | **38** | `allocated_pension` → `account_based_pension` (10 rows) + `retirement_savings` → `other_retirement_assets` (28 rows) — the only two same-table, zero-external-dependency relabels this sub-chunk performs |
| Records catalogue-deprecated only (row physically untouched, now surfaced via the grid's "Archived item" fallback) | **133** | 171 − 38. Includes the 45 Class-F contribution rows (see below), the 10 Class-E rows, and every Class-B/C cross-module pair |
| Deterministic duplicates consolidated (Spec 2 §54-57's strong-evidence bar) | **0** | See "possible duplicates" below — neither of the 2 candidate pairs found met the deterministic bar |
| Possible duplicates preserved (both rows kept, flagged for manual review) | **2 pairs / 4 rows** | 1 `term_deposits` pair, 1 `commercial_property` pair — see detail below |
| Records requiring manual review (flagged, not guessed) | **27** | 10 Class-E rows (`education_fund`/`children_investment`, no reliable reclassification evidence) + 13 Class-F contribution rows (no unambiguous parent account) + 4 possible-duplicate rows |
| Retirement-contributions backfilled with confident evidence | **32** | Single-candidate-parent-account rows — see migration `0039` |
| Migration failures | **0** | Dry-run only; every read-only query against DEV succeeded |

### Per-key row counts (real DEV data)

**Assets** (70 rows total): `term_deposits` 15, `commercial_property` 6,
`private_equity` 4, `business_ownership` 4, `partnership_interest` 4,
`defined_benefit` 3, `managed_funds` 3, `cryptocurrency` 2, `shares` 2,
`bonds` 2, `etfs` 1, `retail_super` 1, `smsf_balance` 1, `trust_assets` 1,
`investment_property` 21. (`industry_super`: 0 rows in DEV today.)

**Investments** (18 rows total): `children_investment` 6, `smsf_investments`
4, `education_fund` 4, `high_interest_savings` 4.

**Retirement** (83 rows total): `retirement_savings` 28, `allocated_pension`
10, `salary_sacrifice` 9, `employer_contributions` 8, `personal_concessional`
8, `non_concessional` 8, `spouse_contribution` 7, `government_co_contribution`
5.

**SMSF 3-way overlap**: `asset.smsf_balance` 1 row, `investment.
smsf_investments` 4 rows, `retirement.smsf` (canonical, untouched) 2 rows.
Confirms AR-0's finding that this overlap, while structurally the most
severe in the taxonomy, has very low populated volume today.

## Possible-duplicate rows (preserved, flagged — not consolidated)

Evidence tested per row pair: value match (within $0.01), currency match,
and `created_at` within a 5-minute window (a proxy for "entered in the same
data-entry session," since neither table has an institution/account-number
field to cross-check more directly). **Both real candidate pairs matched on
value and currency but NOT on timing** — i.e. the two rows were saved at
meaningfully different times, which is real, if imperfect, evidence against
"the same data-entry action created both," so per Spec 2 §54-57's "never by
value alone" rule, **both are classified `possible_duplicate`, not
`deterministic_duplicate`, and both rows are left completely untouched**:

1. User `af048889-efb0-4d27-8f53-5fa6c202cd7c`: `asset.term_deposits` and
   `investment.term_deposits`.
2. User `5e5aa253-18f2-4190-8eef-4c1fee42a26e`: `asset.commercial_property`
   and `investment.commercial_property`.

These are the same 2 users AR-0's discovery pass already flagged
independently — re-confirmed here with the added timing evidence. Both
should go to a human reviewer (e.g. via account-level correspondence) to
confirm whether they're genuinely the same holding double-entered, or two
distinct holdings that happen to share a value.

## Class-E rows (`education_fund` / `children_investment`) — why none were auto-reclassified

All 10 real rows found:

| id | key | name | value | evidence quality |
|---|---|---|---:|---|
| `1d7682d8…` | education_fund | "Bond and Cash Fund" | 30,000 | descriptive but not a real institution/notes signal |
| `bf1b8e52…` | education_fund | "Gold or Sovereign Gold Bond" | 1,600,000 | same |
| `db69fa44…` | education_fund | "Debt Fund or Fixed Deposit" | 1,056,000 | same |
| `eeda97e4…` | education_fund | "Education Fund" | 850,000 | generic catalogue-default name, zero signal |
| `44dadeb4…` | children_investment | "Indian Equity Mutual Fund" | 1,344,000 | descriptive but not a real institution/notes signal |
| `4ad0bf65…` | children_investment | "Children Investment" | 1,450,000 | note field literally says "Catalog coverage row" — synthetic fixture data, zero signal |
| `673de52d…` | children_investment | "Bond and Cash Fund" | 30,000 | same as above |
| `74f409ad…` | children_investment | "Gold or Sovereign Gold Bond" | 880,000 | same |
| `f2a7bc54…` | children_investment | "Bond and Cash Fund" | 13,500 | same |
| `f36c5d3c…` | children_investment | "Indian Equity Mutual Fund" | 1,344,000 | same |

**Judgement call, disclosed**: several names look descriptive enough to
suggest a real type (e.g. "Gold or Sovereign Gold Bond" → gold), but this is
the exact same "template-style name that doesn't reliably correspond to
real user intent" pattern AR-0's own discovery pass already flagged as
characteristic of the 50-user synthetic regression-harness fixture data,
not organic entry (`institution` is empty on every single row, and one row's
`notes` field literally reads "Catalog coverage row"). Guessing a specific
investment type from a synthetic label risks establishing a wrong-but-
confident-looking migration precedent for when this pattern meets real user
data. Per this sub-chunk's own instruction ("if none, leave them as a
flagged 'needs reclassification' state rather than guessing"), **all 10
rows are left exactly as saved** — deprecating only the catalogue item
(migration `0038`), not touching any row's `master_item_key`. They surface
via the grid's "Archived item" fallback, fully visible/editable, pending a
human decision (or the future Goal-linking phase this item is explicitly
scoped to precede, per the dispatch's item 5 instructions).

## Class-F contribution rows — parent-account linking evidence

45 real rows found across the 6 contribution keys. Evidence used: same
`user_id`, same `currency_code`, and how many of the user's *other*
retirement rows are a genuine balance-style account (`industry_super`,
`retail_super`, `smsf`, `defined_benefit`, `transition_to_retirement`,
`allocated_pension`/`account_based_pension`, `annuity`, `overseas_pension`,
`other_retirement_assets`/`retirement_savings`, `epf`/`ppf`/`nps`).

- **32 rows**: exactly one candidate parent account for that user+currency
  → backfilled into `retirement_contributions` by migration `0039`, with
  `amount` = the row's own `current_balance`, `frequency` = the row's own
  saved `contribution_frequency` (real data — all 45 rows have
  `contribution_frequency = 'monthly'`, not assumed), `contributor` =
  `'spouse'` only for `spouse_contribution` rows.
- **13 rows**: excluded, genuine data-quality gap, not guessed —
  9 rows have **zero** candidate parent accounts for that user+currency
  (the user has no other retirement holding to link to at all), 4 rows have
  **two** candidate parent accounts (ambiguous — which one actually
  received the contribution cannot be determined from available evidence).
  Full id/user/reason list is in migration `0039`'s trailing comment block.

**Disclosed evidence-strength caveat**: this same-user+same-currency,
single-candidate heuristic is real evidence but a comparatively weak bar —
`retirement_accounts` carries no institution/account-number field to
further disambiguate. This is judged acceptable here specifically because
linking (setting a foreign key on a brand-new row in a table that is never
summed into any total) carries none of the risk a value-merging duplicate
consolidation would; a wrong link only affects which account a
contribution's own record display associates with, never any computed
total. The excluded 13 are handled with the appropriately higher bar
(flagged, not guessed).

## Why no physical/table-level row migration was performed

Every Class-B/C/D deprecation in this sub-chunk (migration `0038`) leaves
the underlying user-owned row **exactly where it is** — still in the
`assets` table, still carrying its original (now-deprecated) `master_item_key`.
This was a deliberate, disclosed scope decision, not an oversight:

1. **"Never delete any user data row"** rules out a real cross-table move
   (`INSERT` into the canonical table + `DELETE` from the old one).
2. A move that does `INSERT` without a matching `DELETE` (to honour
   constraint 1) would create a second, duplicate-value row and directly
   violate the zero-Net-Worth-variance gate — the opposite of this
   sub-chunk's goal.
3. It is unnecessary: `lib/engines/dashboard.ts`'s `computeDashboard()`
   sums `totalAssets`/`totalInvestments`/`totalRetirement` independently by
   **table**, never by catalogue `is_active` or `master_item_key`, so a
   row's physical table location — not its catalogue classification — is
   what determines which total it contributes to. Net Worth
   (`totalAssets + totalInvestments + totalRetirement − totalLiabilities`)
   is therefore invariant under a pure catalogue-level reclassification by
   construction, proven directly in `tests/unit/dashboard.test.ts`'s
   "pure-reclassification zero-variance" suite.
4. This matches migration `0031`'s own established precedent exactly (the
   `collectables`→`collectibles` fix never touched any `assets` row either).

The two exceptions — `allocated_pension`→`account_based_pension` and
`retirement_savings`→`other_retirement_assets` — ARE real, same-table
`UPDATE`s (not table moves), grep-confirmed to have zero external code
dependency on either key, and therefore carry none of the above risk.

## Spec 2 §60 — zero-Net-Worth-variance reconciliation

Computed for the **full DEV population** (206 of 206 users — not just a
sample; the population is small enough to reconcile exhaustively), before
vs. after the proposed migration, using the real row data pulled above.
"Before" reproduces the current (buggy) `dashboard.ts` behaviour exactly
(sums every active `retirement_accounts` row's `current_balance`,
including Class-F phantom-balance rows). "After" applies: (a) the Class-F
exclusion (the disclosed, deliberate defect fix) and (b) would-be
deterministic-duplicate consolidation (zero rows qualified, per above).
Pure module/key reclassification is not separately modelled because it is
provably a no-op for Net Worth (see point 3 above) — every one of the 30
mapping-table catalogue actions falls into either "no row touched" or
"same-table relabel with no value change," both zero-variance by
construction.

| Result | Users |
|---|---:|
| **Zero variance** (pure reclassification only, or no affected row at all) | **167** |
| **Explained variance** (Class-F phantom-balance correction — disclosed, deliberate) | **39** |
| **Unexplained variance (hard-stop candidates)** | **0** |

**Zero unexplained variance across the entire 206-user population.** No
case was found requiring a hard stop; every user whose Net Worth changes as
a result of this migration changes for exactly one documented reason (the
Class-F fix), by exactly the amount the removed phantom balance accounts
for, and the reconciliation below proves it line by line.

### Explained-variance detail (all 39 affected users — "Old calculation → defect → corrected rule → expected new result")

For every user below: **Old (defective) Net Worth** included one or more
Class-F contribution rows' `current_balance` summed as if they were real
retirement balances. **Defect**: `dashboard.ts`'s `totalRetirement` summed
`retirement_accounts.current_balance` unconditionally, with no exclusion
for contribution-type catalogue rows (Chunk 3a's confirmed live defect).
**Corrected rule**: `isRetirementContributionRow(master_item_key)` excludes
the 6 Class-F keys from `totalRetirement` (see `dashboard.ts`).
**Expected new result** = Old Net Worth − (sum of that user's Class-F rows'
`current_balance`), currency-converted where applicable (INR rows divided
by the FX rate before combining with AUD figures, matching `dashboard.ts`'s
own `reportingValue()` convention) — reproduced exactly below.

| User | Before Net Worth | After Net Worth | Variance | Explained by (contribution correction) |
|---|---:|---:|---:|---:|
| `60457111…` | 607,250.00 | 459,650.00 | −147,600.00 | 147,600.00 |
| `fd57a550…` | 422,571.43 | 242,571.43 | −180,000.00 | 180,000.00 |
| `ea92e844…` | 370,178.57 | 346,607.14 | −23,571.43 | 23,571.43 |
| `3edcbe79…` | 1,647,900.00 | 1,572,900.00 | −75,000.00 | 75,000.00 |
| `75fc8c36…` | 226,071.43 | 214,071.43 | −12,000.00 | 12,000.00 |
| `c4ec6714…` | 232,678.57 | 229,678.57 | −3,000.00 | 3,000.00 |
| `c1c5f507…` | 143,571.43 | 112,714.29 | −30,857.14 | 30,857.14 |
| `76958197…` | 358,035.71 | 340,035.71 | −18,000.00 | 18,000.00 |
| `5e5aa253…` | 1,000,000.00 | 967,600.00 | −32,400.00 | 32,400.00 |
| `8e28545a…` | 265,892.86 | 249,692.86 | −16,200.00 | 16,200.00 |
| `6f10dec4…` | 241,250.00 | 198,392.86 | −42,857.14 | 42,857.14 |
| `af048889…` | 882,285.71 | 837,285.71 | −45,000.00 | 45,000.00 |
| `dca43ce2…` | 231,482.14 | 152,910.71 | −78,571.43 | 78,571.43 |
| `9d58f4e1…` | 214,821.43 | 199,821.43 | −15,000.00 | 15,000.00 |
| `a75c38e5…` | 271,070.00 | 248,390.00 | −22,680.00 | 22,680.00 |
| `705c72d7…` | 507,281.25 | 476,424.11 | −30,857.14 | 30,857.14 |
| `12a3e92b…` | 413,571.43 | 401,571.43 | −12,000.00 | 12,000.00 |
| `d8039853…` | 630,000.00 | 597,600.00 | −32,400.00 | 32,400.00 |
| `b0680754…` | 446,767.86 | 338,732.14 | −108,035.71 | 108,035.71 |
| `854fd280…` | 226,071.43 | 195,214.29 | −30,857.14 | 30,857.14 |
| `26addcb7…` | 1,392,321.43 | 336,321.43 | −1,056,000.00 | 1,056,000.00 |
| `4672a2f3…` | 1,589,600.00 | 1,049,600.00 | −540,000.00 | 540,000.00 |
| `6e876aaf…` | 710,357.14 | 562,757.14 | −147,600.00 | 147,600.00 |
| `387ddc55…` | 616,000.00 | 468,400.00 | −147,600.00 | 147,600.00 |
| `76d59bf7…` | 281,482.14 | 217,196.43 | −64,285.71 | 64,285.71 |
| `9bed77aa…` | 481,000.00 | 377,680.00 | −103,320.00 | 103,320.00 |
| `0fd32c7a…` | 209,553.57 | 197,553.57 | −12,000.00 | 12,000.00 |
| `79c7f796…` | 630,000.00 | 482,400.00 | −147,600.00 | 147,600.00 |
| `8454c9a3…` | 227,678.57 | 196,821.43 | −30,857.14 | 30,857.14 |
| `2984ac17…` | 477,750.00 | 445,350.00 | −32,400.00 | 32,400.00 |
| `8606247e…` | 617,750.00 | 585,350.00 | −32,400.00 | 32,400.00 |
| `99d6ac7b…` | 522,035.71 | 425,607.14 | −96,428.57 | 96,428.57 |
| `891e877b…` | 630,000.00 | 482,400.00 | −147,600.00 | 147,600.00 |
| `f2ceb877…` | 331,607.14 | 288,750.00 | −42,857.14 | 42,857.14 |
| `818f64c1…` | 408,267.86 | 315,410.71 | −92,857.14 | 92,857.14 |
| `e0b1a5da…` | 377,500.00 | 365,500.00 | −12,000.00 | 12,000.00 |
| `4bf647fd…` | 219,875.00 | 141,303.57 | −78,571.43 | 78,571.43 |
| `1f356dd1…` | 338,392.86 | 326,392.86 | −12,000.00 | 12,000.00 |
| `d0f4afcc…` | 250,892.86 | 220,035.71 | −30,857.14 | 30,857.14 |

Every row's `variance` column equals its `explained-by` column exactly
(negated) — confirmed programmatically by the audit script itself
(`Math.abs(variance - explainedVariance) > 0.01` is the hard-stop
condition, and it triggered zero times across all 206 users).

## Conclusion

- Zero unexplained Net Worth variance across the full 206-user DEV
  population.
- 39 users' Net Worth changes by exactly the amount of their own removed
  Class-F phantom balance(s) — a disclosed, deliberate, and correct defect
  fix, not a migration side-effect.
- 167 users are completely unaffected (byte-for-byte identical Net Worth).
- 27 rows are flagged for manual review rather than guessed at (10 Class-E,
  13 Class-F ambiguous-parent, 4 possible-duplicate).
- No case required a hard stop.
