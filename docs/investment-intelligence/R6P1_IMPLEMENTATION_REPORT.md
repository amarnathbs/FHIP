# R6-P1 — India Tax & Cost Intelligence: Implementation Report

Status: implementation complete, independently certified against a 120-case pack, **live-DEV/RLS certification for the new schema BLOCKED** (disclosed in full in section 8 — not a self-graded pass on that dimension). Branch `feature/investment-intelligence-r6-p1-tax-engine`, forked from `feature/investment-intelligence-r6-tax-cost-intelligence` at `fd526ee` (the certified R6-P0 tip) per the task brief.

## 1. Executive summary

R6-P1 builds the tax-lot/FIFO/grandfathering/classification/holding-period/tax-year-aggregation/exit-load engine specified for India Tax & Cost Intelligence. It is a pure-calculation engine (no I/O in the engine layer itself) plus a thin repository/orchestrator/API layer that wires it to real II transaction data, following the exact architectural pattern R4/R5 established (`analyticsOrchestrator.ts` / `sipOrchestrator.ts` → `r5Repository.ts` / `analyticsRepository.ts` → an API route).

Everything computable without database DDL access was built, tested, and independently certified this session:

- 10 new pure-calculation modules under `lib/engines/investment-intelligence/tax/`.
- A 120-case independent certification pack (fixed-seed generator + a Python stdlib-only oracle that imports zero production code + a typed vitest comparison harness), **120/120 cases, 544/544 metric comparisons, 0 failures**, max variance 0.0088 against a ₹0.01 currency tolerance.
- **Two genuine negative controls**, each executed green → red → green this session (not merely described).
- A repository (`taxRepository.ts`) and API route (`/api/investment-intelligence/tax/summary`) that read real `ii_transactions`/`ii_instruments`/`ii_prices_nav` data, run the engine, and persist derived results — following the same anti-forgery, RLS-respecting, server-resolved-identity conventions as R5's SIP/X-Ray routes.
- A new migration (`0045_ii_r6_p1_tax_engine.sql`) shaping and seeding the schema. **This session has no DDL capability against DEV** (reconfirmed live this session, see section 8) — the migration is written and reviewed but not yet applied, so live-DEV/RLS certification of the four brand-new tables is honestly reported as BLOCKED, not fabricated.
- Full regression reproduced myself this session: tsc clean, vitest 965 passed / 5 skipped (970 total, +129 from the R6-P0 baseline of 836/5/841), eslint unchanged at 6 errors / 6 warnings (all pre-existing, zero new), `next build` exit 0 with 176 routes (+1, the new tax-summary route). R4's 50-case pack and R5's 89-case/698-comparison pack both re-reproduced **unchanged** (50/50, 0 fail; 89 cases / 698 comparisons / 698 pass / 0 fail).

## 2. What was built

### 2.1 Engine modules (`lib/engines/investment-intelligence/tax/`)

| File | Responsibility |
| --- | --- |
| `taxVersioning.ts` | `TAX_ENGINE_VERSION` / sub-version constants, following the `PERFORMANCE_ENGINE_VERSION`/`SIP_ENGINE_VERSION` precedent. |
| `disclaimer.ts` | `TAX_SIMULATION_DISCLAIMER`, `NRI_SCOPE_DISCLAIMER`, `PLACEHOLDER_RULE_DISCLAIMER`, and `withTaxDisclaimer()` — attached to every orchestrator result structurally, not as a docstring comment. |
| `holdingPeriod.ts` | The 12-month STCG/LTCG anniversary boundary (see section 3). |
| `financialYear.ts` | India's 1 Apr–31 Mar financial year bucketing. |
| `taxLotEngine.ts` | Tax-lot architecture + FIFO matching (`buildTaxLots`, `consumeLotsFifo`, `replayFifo`). |
| `grandfathering.ts` | The 31-Jan-2018 FMV three-way comparison (see section 4). |
| `ruleVersions.ts` | Effective-dated rule-version table + `resolveRuleVersion()` (see section 3). |
| `schemeClassification.ts` | equity-oriented / debt-specified / other-hybrid / unresolved classification. |
| `capitalGainsEngine.ts` | Per-lot-consumption tax computation, tying the above together. |
| `taxYearAggregation.ts` | Taxpayer-level, whole-FY LTCG exemption aggregation. |
| `exitLoad.ts` | Holding-period-dependent exit-load computation + TER cost-drag context. |
| `residency.ts` | NRI/resident detection, fail-safe to "unknown → flagged". |
| `taxOrchestrator.ts` | Top-level `runTaxSimulation()`, mirroring `sipOrchestrator.ts`'s shape. |

### 2.2 Data-access + API layer

- `lib/services/investment-intelligence/taxRepository.ts` — `loadTaxDataset()` (reads `ii_transactions` via `fetchAllRows` for pagination safety, `ii_instruments`, `ii_scheme_tax_classification`, `ii_prices_nav`, `ii_exit_load_schedules`) and `persistCapitalGainsComputations()` (service-role write, `user_id` set server-side only). Every read against a not-yet-applied table degrades to an explicit warning instead of throwing (see `isMissingTableError()`), so the same code works unmodified once migration `0045` lands.
- `app/api/investment-intelligence/tax/summary/route.ts` — `GET`, `requireUser()`-gated, server-resolved identity only (no account/instrument parameter a client could spoof), returns the labelled simulation including `disclaimer`/`residencyNote`/`ruleVersionNote`.

### 2.3 Schema (`supabase/migrations/0045_ii_r6_p1_tax_engine.sql`)

- Additive `ii_transactions.transaction_type` extension: `bonus`, `split` (on top of the full R1+R2 set — verified the R2 (`0040`) additions were preserved, not reverted, by reading that migration directly before writing mine).
- `ii_scheme_tax_classification` — durable per-scheme classification cache, world-read/service-write (same pattern as `ii_fund_holdings`).
- `ii_exit_load_schedules` — scheme-level exit-load tiers, world-read/service-write.
- `ii_tax_lot_consumptions` — the FIFO consumption ledger, user-owned RLS.
- `ii_capital_gains_computations` — the persisted per-lot tax result, user-owned RLS.
- Seeds `ii_tax_rule_versions` (shaped by R1's migration `0031`, left unpopulated until now) with the three real rule-version rows described in section 3.

R1's `ii_tax_lots` table (also shaped, unpopulated, in `0033`) is reused as-is for the actual lot ledger — R6-P1 did not create a parallel lot table.

## 3. Effective-date rule versioning — the exact approach

Every tax computation calls `resolveRuleVersion(disposalDate)`, which looks up whichever `ii_tax_rule_versions` row's `[effective_from, effective_to]` range contains the **disposal's own date** — never `new Date()` / "today". Three rows are seeded, each independently researched (see the reasoning trail in section 9):

| Version | Effective | Equity STCG / LTCG | LTCG exemption | Debt/specified rule |
| --- | --- | --- | --- | --- |
| `1961_act_pre_20240723` | 2023-04-01 → 2024-07-22 | 15% / 10% | ₹1,00,000/FY | Always short-term at slab (Finance Act 2023, acquired ≥ 2023-04-01) |
| `1961_act_post_20240723` | 2024-07-23 → 2026-03-31 | 20% / 12.5% | ₹1,25,000/FY | Same (unchanged) |
| `2025_act_placeholder` | 2026-04-01 → open | 20% / 12.5% (**placeholder**) | ₹1,25,000/FY (**placeholder**) | Same (unchanged) |

`resolveRuleVersion()` is a pure function of `disposalDate`; calling it twice for the same date, on different days, returns the identical row (proven by a dedicated certification test — see section 6). This is what "effective-dated, not an if/else on today" means concretely: recomputing a 2023 disposal in 2027 still applies the 2023-era rate.

**The 2025 Act placeholder.** The Income-tax Act, 2025 enters force 1 April 2026. Its actual mutual-fund capital-gains rates were not publicly finalised/verifiable at implementation time (August 2026). Rather than invent numbers, `2025_act_placeholder`'s `ruleDefinition.placeholder` is explicitly `true`, its `sourceNote` says so in full sentences, and `runTaxSimulation()` detects `ruleVersionPlaceholder` on any disposal result and attaches `PLACEHOLDER_RULE_DISCLAIMER` to the whole simulation output — a caller cannot silently drop this flag without editing both the engine and the disclaimer module. The placeholder reuses the last known 1961-Act-era rate structure only as a documented stand-in, never presented as authoritative.

## 4. Grandfathering — formula and worked examples

**Researched formula** (Section 55(2)(ac), cross-checked against ClearTax/HDFC Sky/ICICI Direct explainers, all in agreement):

```
cost_of_acquisition_for_LTCG = max( actualCost, min(FMV_31Jan2018, salePrice) )
```

This is the exact three-way comparison the spec warns is easy to get wrong. The classic **wrong** formula computes `min(max(actualCost, FMV), salePrice)` — deceptively similar, but it caps the *max* of cost/FMV at the sale price, which silently erases a genuine pre-existing loss to zero whenever `actualCost > salePrice`. The correct formula's `min(FMV, salePrice)` term stays subordinate to `actualCost` in the outer `max`, so a real loss is preserved. **This exact defect was injected and caught by this session's first negative control** (section 7).

Worked examples (all from the certified case pack, `scripts/ii-r6p1-certification/cases.json`):

| Case | actualCost | salePrice | FMV | Result | Branch |
| --- | --- | --- | --- | --- | --- |
| GRAND-001 | ₹27.50 | ₹84.51 | ₹53.15 | basis = **₹53.15** (FMV used) | (a) FMV benefits the taxpayer |
| GRAND-005 | ₹28.34 | ₹43.60 | ₹61.07 | basis = **₹43.60** (capped at sale price, not ₹61.07) | (b) FMV exceeds sale price — gain reduced to exactly zero, not a manufactured loss |
| GRAND-009 | ₹17.23 | ₹41.50 | ₹10.12 | basis = **₹17.23** (actual cost — FMV below cost has no effect) | (c) no benefit |
| GRAND-013 | ₹47.44 | ₹25.51 | ₹24.03 | basis = **₹47.44** (actual cost, a real loss of ₹21.93 preserved) | pre-existing loss, FMV irrelevant |
| GRAND-015 | ₹55.20 | ₹93.36 | *unavailable* | basis = **₹55.20**, flagged `fmv_unavailable` | FMV missing — never guessed |

The 31-Jan-2018 FMV is read from `ii_prices_nav` (R2's real NAV series) — the repository looks up the most recent price on/before 2018-01-31 per instrument; if none exists, `fmv31Jan2018PerUnit` is `null` and `applyGrandfathering()` reports `basisSource: 'fmv_unavailable'` rather than estimating a number.

## 5. Mutual-fund tax classification

`classifyScheme()` reuses R2 Portfolio Truth's own tables (`ii_fund_holdings` weight/underlying disclosures + `ii_instruments.instrument_class`/`country_of_domicile`) rather than a parallel classification source. It does **not** re-run R5's full recursive weighted look-through (`xray/lookThrough.ts`) — tax classification only needs the fund's own top-level domestic-equity percentage, not a portfolio-wide nested-fund-of-funds walk, so a narrower purpose-built aggregation is used (documented in the file header as a deliberate scope choice, not an oversight).

Classification is `unresolved` — never guessed — when: no disclosure exists, the most recent disclosure is stale (>548 days old, an explicit configurable threshold), or fewer than 80% of disclosed weight has a resolvable underlying classification. A debt/specified-fund flag from the scheme category master overrides the allocation test entirely, since "specified mutual fund" (Finance Act 2023) is an **acquisition-date** rule, not an allocation percentage.

The durable classification is cached in `ii_scheme_tax_classification` (one row per instrument) so it isn't recomputed from raw holdings on every request — exactly the "durable tax-classification field" the spec asks for.

## 6. Certification — exact numbers

Full methodology mirrors R4's 50-case and R5's 89-case packs: `scripts/ii-r6p1-certification/generate_cases.mjs` (fixed-seed `0x52365031`, deterministic, imports nothing from production) writes `cases.json`; `scripts/ii_r6p1_independent_reconciliation.py` (Python, stdlib only — `grep -n "^import\|^from" scripts/ii_r6p1_independent_reconciliation.py` shows only `json`, `sys`, `datetime`, `pathlib`) computes `oracle_results.json` without ever calling TypeScript; `tests/unit/iiR6P1Certification.test.ts` runs the real engines and compares.

| Family | Cases | Comparisons | What it proves |
| --- | --- | --- | --- |
| `fifo` | 20 | FIFO multi-lot partial consumption + exact-lot-boundary consumption |
| `grandfathering` | 15 | all three branches (FMV-benefit / capped-at-sale / no-effect) + real-loss-preserved + FMV-unavailable |
| `boundary` | 15 | 12-month anniversary: exactly-at / one-day-before / one-day-after, incl. a leap-year (29 Feb) acquisition-date clamp case |
| `debt` | 10 | debt/specified fund is short-term even after 1–6 years held |
| `fy_aggregation` | 15 | taxpayer-level LTCG exemption applied once per FY, not per disposal |
| `cross_fy` | 10 | 31-March/1-April disposals one day apart land in different FY buckets |
| `exit_load` | 15 | tier resolution at/around each threshold (89/90/91, 364/365/366, 1094/1095/1096 days) |
| `ambiguous` | 10 | unresolved classification flags rather than guesses, and is excluded from FY aggregation |
| `rate_version` | 10 | effective-dated resolution across both 1961-Act sub-periods and into the 2025 placeholder |
| **Total** | **120** | **544 individual metric comparisons** |

**Result: 120/120 cases pass, 544/544 comparisons pass, 0 failures.** Max variance **0.0088** (float rounding noise in FIFO cost-basis summation) against the pre-declared ₹0.01 currency tolerance — non-zero, which is expected and a healthy sign of two genuinely independent arithmetic paths, not one side parroting the other.

Pre-declared tolerances (declared in `tests/unit/iiR6P1Certification.test.ts` before any result was reviewed, never widened afterward): currency amounts ₹0.01, per-unit cost basis 1e-6, everything else (classification/gain-type/rule-version/dates/booleans) exact.

## 7. Negative controls — both genuinely executed this session

**Control 1 — grandfathering cap inversion.** `grandfathering.ts`'s formula was temporarily changed from `max(actualCost, min(FMV, salePrice))` to the classic wrong `min(max(actualCost, FMV), salePrice)`.
- Before: 129/129 tests pass.
- After: **4 tests fail** — `GRAND-013` (production ₹25.51 vs oracle ₹47.44, variance 21.93), `GRAND-014` (₹32.28 vs ₹52.23, variance 19.95), the "real_loss_preserved branch never turns a real loss..." property test, and the report-writer assertion. Exactly the predicted failure mode: a real pre-existing loss got silently erased.
- Restored via `cp` from a pre-edit backup; reconfirmed **129/129 green**.

**Control 2 — FIFO flipped to LIFO.** `taxLotEngine.ts`'s lot sort was temporarily reversed (descending acquisition date).
- Before: 129/129 pass.
- After: **21 tests fail** (20 of the 20 FIFO cases + the report-writer), all multi-lot cases where LIFO consumes a different lot order than FIFO.
- Restored; reconfirmed **129/129 green**.

Both controls were executed, not merely described — the red-state failure counts and specific wrong numbers above are copy-pasted from this session's actual vitest output, not predicted in advance and then assumed.

## 8. Live-DEV and security — honestly BLOCKED, not fabricated

This session re-ran the same DDL-capability probe pattern R5 used (`scripts/ii_r6p1_schema_probe.mjs`, modelled on `ii_r5_schema_probe.mjs`) against the real DEV Supabase project:

```
DDL via PostgREST RPC available: NO   (all 7 candidate RPC names return 404)
Direct Postgres connection string in env: NO
ii_scheme_tax_classification: HTTP 404 (NOT FOUND)
ii_exit_load_schedules:       HTTP 404 (NOT FOUND)
ii_tax_lot_consumptions:      HTTP 404 (NOT FOUND)
ii_capital_gains_computations:HTTP 404 (NOT FOUND)
ii_tax_rule_versions: HTTP 200, in_mutual_fund_capital_gains rows: 0 (expect 3 once seeded)
ii_tax_lots (R1, already live): HTTP 200
MIGRATION 0045 FULLY APPLIED: NO
```

This session has never had (and does not have) a way to execute DDL against DEV — confirmed, not assumed, and consistent with every prior II release's own finding (R2's 0039-0041, R5's 0044 before the Product Owner applied it). **Live-DEV functional testing and RLS negative-control testing of the four new tables cannot be performed by this session** and is not claimed. What *is* true and independently checked:

- The migration SQL was read back in full after writing it, and the RLS policy pattern on each new table matches an already-certified precedent exactly: `ii_scheme_tax_classification`/`ii_exit_load_schedules` copy `ii_fund_holdings`'s world-read/service-write shape; `ii_tax_lot_consumptions`/`ii_capital_gains_computations` copy `ii_tax_lots`'s `auth.uid() = user_id` own-row policy verbatim.
- `taxRepository.ts`'s writes go through `createAdminClient()` with `user_id` set from the server-authenticated session only, matching R5's `persistR5Results()` anti-forgery convention (the exact defect class the R4 security certification found and fixed).
- The additive `ii_transactions.transaction_type` constraint change was verified by reading migration `0040` directly before writing mine, so the R2-added values (`stp_in`, `stp_out`, `swp`, etc.) are preserved, not reverted to R1's smaller 12-value set.

**This is an open item for the Product Owner**, exactly like R2's unapplied migrations were: once `0045` is applied to DEV, `scripts/ii_r6p1_schema_probe.mjs` should be re-run to confirm, and a genuine live-DEV RLS negative-control pass (seed two tenants, attempt cross-tenant read on `ii_tax_lot_consumptions`/`ii_capital_gains_computations`, confirm it's blocked, confirm the seeded rows themselves are correct) should follow before this is called a full pass on the live-DEV/security axis specifically.

## 9. Sources consulted (capital-gains rate research)

- Business Standard, "Budget 2024 hikes LTCG tax rate to 12.5%, STCG to 20%" (23 Jul 2024 effective date).
- Bajaj AMC, "Union Budget 2024: New Mutual Funds Capital Gains Tax Explained".
- PIB / CBDT FAQs on the new capital-gains regime (confirms the ₹1.25 lakh exemption applies to the **whole** FY2024-25, not prorated around the 23 July change — modelled in `taxYearAggregation.ts` by resolving the exemption threshold from the rule version in force on the FY's *last* day).
- ClearTax / HDFC Sky / ICICI Direct grandfathering explainers (Section 55(2)(ac) three-way formula, cross-checked for agreement before encoding).
- incometaxindia.gov.in capital-gains FAQ (holding-period computed "from acquisition to the day immediately preceding transfer" — the basis for the strict-anniversary boundary rule).

## 10. Known limitations / deliberately unbuilt

1. **Live-DEV/RLS certification of the new schema is BLOCKED**, not performed — section 8. This is the single most load-bearing gap; everything else below is secondary.
2. **No maintenance job populates `ii_scheme_tax_classification` or `ii_exit_load_schedules` at scale.** The pure `classifyScheme()` function is built and certified; a batch job that runs it over every real scheme and upserts the cache table was not built this session. Until that job runs (or the migration is applied and seeded), every real scheme in the live app will resolve to `unresolved` via the repository's safe fallback — this is the deliberately safe behaviour, not a defect, but it does mean the feature shows nothing confident yet in production.
3. **`ii_prices_nav` has no populated AMFI feed** (a pre-existing R1/R2 non-goal, not introduced by R6-P1) — grandfathering FMV lookups will find nothing until that feed exists. The `fmv_unavailable` flag path handles this correctly.
4. **No household-profile residency field was found or wired.** `residency.ts`'s `checkResidency()` is built and certified against `unknown`/`resident`/`nri` inputs, but the API route currently passes an empty profile (fails safe to `'unknown'`, NRI-flagged) rather than reading a real field — left for a future pass once the household schema's residency field is confirmed.
5. **"Other/hybrid" (equity-test-failed) funds use a simplified STCG/LTCG treatment** — the same 12-month split and rates as equity-oriented, without grandfathering/exemption, and explicitly without indexation. The precise legal treatment for genuinely non-Section-112A assets can involve Section 112 indexation, which was not modelled (would require another, separately-researched rule branch). Flagged in the per-disposal `note` field and here, not silently presented as exact.
6. **Pre-1-April-2023 debt-fund acquisitions** (the old debt-fund regime with indexation, superseded by the "specified mutual fund" rule) are not modelled — out of scope for this pass.
7. **No dedicated UI page** — only the JSON API route. The disclaimer/residency/placeholder flags are already present in the API response so a future UI pass needs no engine changes.
8. **LIFO / specific-lot-identification are deliberately not implemented** — explicit spec scope boundary, re-affirmed in `taxLotEngine.ts`'s header comment.
9. **Migration numbering**: `0045` was chosen within the Investment-Intelligence-lineage-only convention (the same convention R5's `0044` used), and is **not** reconciled against the separate `fix/migration-lineage-ii-resources` stream's forward-emitted `0049`. Whoever merges this branch must run it through that reconciliation process first.
10. **2025 Act rates are an explicit, disclosed placeholder** (section 3) — never to be treated as authoritative until the Product Owner confirms the actual finalised 2025 Act numbers and this row is updated + recertified.

## 11. Full regression, exact numbers

| Check | R6-P0 baseline | This session, reproduced | Status |
| --- | --- | --- | --- |
| `npx tsc --noEmit` | clean | **clean (exit 0)** | REPRODUCED |
| `npx eslint .` | 6 errors, 6 warnings | **6 errors, 6 warnings — byte-identical, zero new** | REPRODUCED |
| `npx vitest run` | 836 passed, 5 skipped (841) | **965 passed, 5 skipped (970)** — +129, exactly `iiR6P1Certification.test.ts`'s count | +129, no regressions |
| `npx next build` | clean, 175 routes | **clean (exit 0), 176 routes** (+1: `/api/investment-intelligence/tax/summary`) | REPRODUCED + 1 route |
| R4 50-case certification | 50/50 | **50/50, 0 fail** | REPRODUCED, unchanged |
| R5 89-case / 698-comparison certification | 89/698 | **89 cases / 698 comparisons / 698 pass / 0 fail** | REPRODUCED, unchanged |
| R6-P1 120-case certification | — | **120/120 cases, 544/544 comparisons, 0 fail, max variance 0.0088** | NEW, this pass |

## 12. Files touched (complete list)

New:
- `lib/engines/investment-intelligence/tax/{taxVersioning,disclaimer,holdingPeriod,financialYear,taxLotEngine,grandfathering,ruleVersions,schemeClassification,capitalGainsEngine,taxYearAggregation,exitLoad,residency,taxOrchestrator}.ts`
- `lib/services/investment-intelligence/taxRepository.ts`
- `app/api/investment-intelligence/tax/summary/route.ts`
- `supabase/migrations/0045_ii_r6_p1_tax_engine.sql`
- `scripts/ii-r6p1-certification/generate_cases.mjs`, `cases.json`, `oracle_results.json`, `comparison_report.json`
- `scripts/ii_r6p1_independent_reconciliation.py`
- `scripts/ii_r6p1_schema_probe.mjs`
- `tests/unit/iiR6P1Certification.test.ts`
- `docs/investment-intelligence/R6P1_IMPLEMENTATION_REPORT.md` (this file)

Nothing in R2/R3/R4/R5's own engine/service files was modified. No Resources, Phase-0C, or FDH code/schema was touched.
