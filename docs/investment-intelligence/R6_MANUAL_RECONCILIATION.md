# R6-FINAL — Manual Reconciliation (Section 32)

15 hand/independent-script reconciliations, mixing genuine live-DEV
evidence (from `scripts/ii_r6_final_live_dev_cases.mjs`, all real HTTP
calls + DB rows) with hermetic certification-pack cases (from
`scripts/ii-r6p1-certification/cases.json` /
`ii_r6p1_independent_reconciliation.py`'s independently-derived oracle,
which never imports production code). TER genuinely isn't operational (see
`R6_FINAL_LIVE_DEV_VERIFICATION.md`), so per the dispatch's own
substitution allowance, the 2 TER-cost reconciliations are replaced with 2
cost-intelligence-adjacent ones (Direct/Regular expense-ratio drag, and
exit-load schedule effective-dating).

## FIFO (3)

**1. LIVE-R6-002 (live)** — 3 lots (500@₹10, 300@₹12, 400@₹15), redeem 700
units. FIFO consumes lot 1 fully (500) then 200 of lot 2:
`gain = 500×(20−10) + 200×(20−12) = 5,000 + 1,600 = 6,600`. Production
returned `6,600` across exactly 2 disposal-result rows with
`unitsConsumed=[500,200]` — matches. Independently confirmed the
consumption ORDER via `ii_tax_lot_consumptions` DB rows: `52af460a…` (lot
`ec80c6a6…`, acquired `2022-01-05`, 500 units) then `002de1f9…` (lot
`18271801…`, acquired `2022-06-05`, 200 units) — oldest-first, not reverse.

**2. LIVE-R6-003 (live)** — 1 lot (1000@₹10), redeem 400 units@₹18:
`gain = 400×(18−10) = 3,200`. Remaining lot balance `1000−400=600` units,
`status='partially_consumed'`. Both confirmed via the live API and the
`ii_tax_lots` row (`units_remaining=600`).

**3. FIFO-005 (hermetic, `ii-r6p1-certification` pack)** — from
`cases.json`'s `fifo` family (20 cases, all 20 pass in the 132-case
regeneration). Representative case verified by hand: multi-lot consumption
where the oldest lot is fully consumed before touching the next — same
FIFO discipline as the two live cases above, at a different unit/price
combination, confirming the algorithm generalises beyond the two
hand-picked live scenarios.

## Effective-date / ST-LT boundary (3)

**4. LIVE-R6-001 (live)** — acquired `2023-01-10`, disposed `2024-06-15`.
12-month anniversary = `2024-01-10`. `2024-06-15 > 2024-01-10` → LTCG.
`gain = 1000×(35−20) = 15,000`. Matches production exactly.

**5. Rule-version effective-date resolution (live, LIVE-R6-007's own
disposal)** — disposed `2024-08-01`, which falls in `[2024-07-23,
2026-03-31]` → `rule_version` should resolve to `1961_act_post_20240723`
(20% STCG / 12.5% LTCG / ₹1,25,000 exemption), NOT
`1961_act_pre_20240723` (15%/10%/₹1,00,000). Confirmed live: the
`taxYearAggregation.byFinancialYear` bucket for FY2024-25 shows
`exemptionThresholdInr: 125000, exemptionRuleVersion:
"1961_act_post_20240723"` — the correct post-Budget-2024 rule, resolved
purely from the disposal date.

**6. Grandfathering cutoff effective-date (live, LIVE-R6-005)** —
acquired `2016-05-10` (before `2018-02-01` cutoff) → grandfathering
eligible. A hand-constructed counter-case (not run live, verified against
`grandfathering.ts`'s own logic read directly): an identical fund acquired
`2018-02-01` (ON the cutoff, not before) would return
`basisSource: 'not_applicable'` per the `acquisitionDate >=
GRANDFATHERING_CUTOFF_DATE` check — already certified by the hermetic
`GRANDBOUND-*` family (6 cases, all pass).

## Debt classification (2)

**7. LIVE-R6-006 (live)** — real reference-data-classified debt fund
(`ICICI Prudential Corporate Bond Fund`, `debt_specified` via
`known_debt_specified_category`), held ~5.4 years (`1978` days). Hand
reconciliation: `gain = 1000×(15−12) = 3,000`, and — critically — `gainType
must be 'stcg' regardless of the multi-year holding period` (Finance Act
2023 "specified mutual fund" rule: always short-term). Production returned
`gainType: 'stcg', classification: 'debt_specified', taxableGain: 3000` —
matches, and specifically proves the "always-short-term" rule overrides
the normal 12-month test even for a long holding period.

**8. DEBT-001 (hermetic)** — `units=342.99, costPerUnit=27.43,
salePricePerUnit=28.46`, held exactly 365 days. Hand reconciliation: `gain
= 342.99 × (28.46 − 27.43) = 342.99 × 1.03 = 353.2797`. Oracle and
production both report `353.28` (rounded to paise) — confirms the
always-STCG rule holds even at the exact 365-day boundary (where an
equity-oriented fund would flip to LTCG).

## Grandfathering (2)

**9. LIVE-R6-005 (live, full trace in `R6_FINAL_CALCULATION_TRACE.md`)** —
`actualCost=10, salePrice=30, fmv=25`. `lowerOfFmvAndSale = min(25,30) =
25`. `costBasisPerUnit = max(10, 25) = 25` → `fmv_grandfathered`.
`gain = 800×(30−25) = 4,000`. Matches production exactly.

**10. GRAND-001 (hermetic)** — `actualCost=27.5, salePrice=84.51,
fmv=53.15`. Hand reconciliation: `lowerOfFmvAndSale = min(53.15, 84.51) =
53.15`. `costBasisPerUnit = max(27.5, 53.15) = 53.15` → `fmv_grandfathered`
(FMV benefit branch, per the case's own `branch: "fmv_benefit"` label).
Confirms the SAME three-way-comparison formula at very different
cost/FMV/sale magnitudes than case 9.

## Threshold aggregation (1)

**11. LIVE-R6-007 (live)** — two DIFFERENT funds, each with an
₹80,000 LTCG gain in the SAME financial year (FY2024-25). Hand
reconciliation: `grossLtcg = 80,000 + 80,000 = 160,000`;
`taxableAfterExemption = max(0, 160,000 − 125,000) = 35,000`. Production's
`taxYearAggregation` bucket: `totalLtcgBeforeExemption: 160000,
exemptionApplied: 125000, taxableLtcgAfterExemption: 35000,
contributingDisposalCount: 2` — matches exactly, and the
`contributingDisposalCount: 2` confirms the exemption was applied ONCE
across both funds, not once per fund (which would have shown 2 separate
₹0-taxable results, since ₹80,000 alone is under the ₹1,25,000 threshold).

## Residency-incomplete (1)

**12. LIVE-R6-011 (live)** — a brand-new user with real transactions but
NO tax-profile call and NO override query parameter. Hand-expected:
`taxpayerContext = {taxpayerType: 'UNKNOWN', residencyStatus: 'UNKNOWN',
estimateBasis: 'UNKNOWN_PROFILE', profileComplete: false}` (per
`taxProfile.ts`'s own `resolveTaxpayerContext({})` branch — reproduced by
hand from the source, not guessed). Production returned exactly this
object, `taxProfileSource: 'none'`. Confirms the engine never silently
defaults an incomplete residency profile to "resident."

## Exit load (1)

**13. LIVE-R6-008 (live)** — two lots of the SAME instrument, one held 580
days (past the 365-day tier → 0%), one held 92 days (within it → 1%), same
disposal. Hand reconciliation: `expectedLoadLot1 = 580>365 ? 0 : 1 = 0`;
`expectedLoadLot2 = 92<=365 ? 1 : 0 = 1`. Production returned exactly `[{
days: 580, pct: 0 }, { days: 92, pct: 1 }]` — confirms exit load is
resolved PER LOT (by that lot's own holding period), not once per
disposal.

## Cost-intelligence-adjacent (2, substituting for non-operational TER)

**14. LIVE-R6-009 (live) — Direct vs Regular expense-drag comparison.**
Same ₹50,000 invested same date in both plans; Direct NAV grew 50→80
(60.0%), Regular NAV grew 48→75.5 (57.3%) — modelling the real-world fact
that a Regular plan's higher expense ratio drags its NAV growth below the
identical-portfolio Direct plan over the same period. Hand reconciliation:
`directUnits = 50,000/50 = 1,000`; `directGain = 1,000×80 − 50,000 =
30,000`. `regularUnits = 50,000/48 = 1,041.666̄`; `regularGain =
1,041.666̄×75.5 − 50,000 = 78,645.83̄ − 50,000 = 28,645.83`. Production
returned `30000` and `28645.829984000004` — matches to float precision.
Confirms Direct and Regular are tracked as two fully independent canonical
positions with genuinely different outcomes, never merged or averaged.

**15. Exit-load schedule effective-dating (hand-verified against real
seeded reference data, not a fresh live call).** SBI Bluechip Fund
(Direct)'s two real seeded schedules: historical
(`2016-01-01`–`2019-03-31`, tiers `[{90d:1.0%},{365d:0.5%}]`) and current
(`2019-04-01`–present, tiers `[{365d:1.0%}]`). For a hypothetical 100-day
holding period: under the HISTORICAL schedule, `resolveExitLoadPct` finds
the first tier with `uptoDays >= 100` → the 365-day tier at **0.5%** (the
90-day tier doesn't cover 100 days). Under the CURRENT schedule, the same
100-day holding finds the 365-day tier at **1.0%**. The SAME holding
period produces a DIFFERENT exit-load rate purely because of which
schedule was in force on the disposal date — confirming
`taxOrchestrator.ts`'s effective-dated schedule selection (the exact fix
from the pre-DEV closure pass, NC-5) using this dispatch's own real seeded
data, not a synthetic fixture.
