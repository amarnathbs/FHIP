# NAV2 - Existing code reused, duplicate formulas found and eliminated

Spec Phase A: "Identify existing reusable financial math and eliminate duplicate formula implementations." Evidence label: read from the repository at `bf2e101`; the edits listed in section 2 were re-checked by running the existing suites for each touched file.

## 1. Reused as is (no change)

| Reused | Where | Used for |
|---|---|---|
| `xirr()` (`xirr-newton-bisection-v1`) | `lib/engines/investment-intelligence/xirr.ts` | the only personal return; NAV2 wraps it, never re-solves |
| `valueHoldingAsOf`, `selectLatestEligibleNav`, `isNavQualityEligible` | `valuation/currentHoldingValuation.ts` | current value (units x latest ELIGIBLE NAV, NAV's own date, statement kept separate, redeemed = 0); NAV eligibility vocabulary (future / quality / currency / price) |
| `maxDrawdown`, `beta` | `riskMetrics.ts` | drawdown peak / trough / recovery and the beta arithmetic (NAV2 adds its own minimum-evidence and typed-state layer around them) |
| `declaredWins`, `benchmarkBasisLabel`, `BenchmarkSegmentInput` | `holdingBenchmarkComparison.ts` | benchmark mapping precedence and the honest category-reference label |
| `toMonthEndSeries` | `rollingReturnService.ts` | monthly resampling |
| `fingerprintInputs` | `analyticsVersioning.ts` | the series checksum |
| `attributeByBasisPoints` | `ownerAttribution.ts` | joint ownership split (60 / 40 sums to 100%) |
| `resolveScheme` | `schemeResolution.ts` | scheme identity (tested in Fixture E; one finding below) |
| `loadCoverage`, `loadAttempts`, `planSchemeGap`, `inFailureCooldown`, `classifySchemeHistory`, `runUserNavHistoryBatch` | `pc6/userNavHistory.ts` | the existing user-scoped fetch the planner sits on top of |
| `orderHydrationWork`, `chunkDateWindow`, `MAX_FETCH_WINDOW_DAYS`, `HydrationAttemptRecord` | `pc6/selectiveHistoricalHydrationJob.ts` | fair ordering and bounded request width |
| `formatDateShort` | `lib/engines/date.ts` | every date in user-visible text (INR `dd-mm-yyyy`, otherwise `dd/mm/yyyy`) |
| `getPlanTier` / `canViewPremiumReport` | `lib/services/entitlements.ts` | Premium gate (Stage 2) |

## 2. Existing files edited (behaviour-preserving; each suite re-run)

| File | Edit | Why | Suite re-run |
|---|---|---|---|
| `riskMetrics.ts` | `export` added to `mean` and `sampleStdDev` | NAV2 reuses them instead of keeping copies | `iiR4RiskMetrics` |
| `rollingReturns.ts` | `export` added to `median` | same | `iiR4Rolling` |
| `navReturn.ts` | new `annualiseGrowth(ratio, days, daysPerYear = 365)`; the existing functions are untouched | one annualisation formula callable with NAV2's 365.2425 without changing the certified actual/365 behaviour | `iiR4NavReturn` |
| `sip/dateAlignment.ts` | `resolveObservationAsOf` takes an optional `maxBackwardDays` (default `MAX_BACKWARD_SEARCH_DAYS`) and finds the NAV by binary search instead of a backwards scan | NAV2's boundary lookup window is policy-driven, and the scan made rolling windows quadratic; the result is identical for a sorted series | `iiR5NoFabrication`, `iiFinding5CrossConsumerNavConsistency` |
| `holdingBenchmarkComparison.ts` | the five per-segment gates extracted into exported `segmentGateFailure()`; `compareInner` now calls it | beta / alpha apply the SAME gates through the SAME code (eliminates a second copy) | `holdingBenchmarkComparison` |
| `pc6/userNavHistory.ts` | `loadUserHeldFundDates()` extracted from `loadUserSchemeNeeds` (same reads, same rule); optional `requiredFromOverrides` on `runUserNavHistoryBatch` and `getUserNavHistoryStatus` (can only move a date earlier, only for the caller's own schemes) | the planner reads the same canonical rows by the same rule and executes through the same path | `userNavHistory` |

## 3. Duplicate or conflicting formulas found

| # | Finding | Status |
|---|---|---|
| D1 | **Three year-length conventions** for annualising a return: actual/365 (`navReturn.ts`, the Performance tab, the SIP engine's XIRR), 365.25 (`benchmarkService.benchmarkWindowReturn`), 365.2425 (NAV2, spec 8.2). On spec example 1 the NAV2 CAGR is 0.099926140 and the R4 value 0.099856588 (about 0.007 percentage points apart). | **Not eliminated; PO decision.** NAV2 follows its spec; R4 is certified and unchanged. If both appear on one screen the labels differ ("Scheme CAGR" under NAV2 versus the Performance tab's figure). Recommend aligning the older ones in a separate, certified change, or stating the convention beside each |
| D2 | **Sharpe, Sortino and alpha are defined differently in R4 and NAV2.** R4 Sharpe = annualised geometric return minus a rate, over annualised volatility; Sortino downside deviation divides by `n - 1` with a zero default target; alpha is annualised geometrically. NAV2 (spec 8.8, 8.9, 8.12) uses mean excess return over the standard deviation of excess return, the matched risk-free as target with a mean over all periods, and arithmetic annualisation. | **Not eliminated; both versioned** (`risk-metrics-v1` and `nav2-sharpe-excess-v1`, `nav2-sortino-all-periods-v1`, `nav2-jensen-alpha-arithmetic-v1`). R4 callers are untouched. PO decision whether the Performance tab should later move to the NAV2 definitions (it would change certified numbers) |
| D3 | **Four "latest observation on or before a date" implementations**: `resolveObservationAsOf` (R5, the documented single rule), `valueOnOrBefore` (`benchmarkService.ts`, unbounded linear scan), `pickNavForInvestmentDate` (`investmentDate.ts`, 7-day limit), `selectLatestEligibleNav` (valuation). | NAV2 uses ONLY `resolveObservationAsOf` (also for the risk-free lookup) and `isNavQualityEligible`. The others remain: they have different window semantics and are certified. Candidate for a later consolidation |
| D4 | `mean`, `sampleStdDev`, `median` were private to R4 files. | **Eliminated for NAV2**: exported and reused; no NAV2 copy |
| D5 | The benchmark gate predicates existed once inline in the holding-period comparison. | **Eliminated**: extracted to `segmentGateFailure`, shared |
| D6 | **Three risk-free resolvers**: `lookupRiskFreeRate` (`config/.../riskFreeRate.ts`, period lookup, no staleness, no governance), `resolveRiskFree` (`pc6/riskFreeSeries.ts`, period lookup, `pending_po_decision`), and NAV2's `riskFreeObservationOn` (step function with a staleness constant, governed dataset, attribution). | NAV2 does not use the first two (the DEV seed table behind them is uncertified). PC6 blocker PO-PC6-2 is resolved for NAV2 by the PO decision; the R4 resolvers stay for R4. Stage 2 decides whether R4 moves to the governed dataset |
| D7 | Calendar helpers: `addDays` is private in at least five files (`userNavHistory`, `holdingBenchmarkComparison`, `selectiveHistoricalHydrationJob`, `navRetentionPolicy`, `reportNavDependencyManifest`). | NAV2 added `lib/engines/nav2/dates.ts` (`addDaysIso`, `subtractMonthsIso`, `weekdayCount`, `isoWeekKey`, `isValidIsoDate`): `subtractMonthsIso` did not exist, but `addDaysIso` is one more copy. Whole-day differences reuse `daysBetween` from `dateAlignment`. Candidate for a shared date module |
| D8 | R4 rolling returns (`rollingReturnSeries`) use month-end endpoints, a 20-day tolerance, always annualise and need 6 windows; NAV2 rolling (spec 8.5) uses one window per available observation, a 10-day lookup, absolute under 12 months, summary at 60 windows. | Different definitions, not copies; both versioned; R4 untouched |
| D9 | The NAV row-eligibility vocabulary (`future_dated`, `quality_not_ok`, `currency_mismatch`, `invalid_price`) exists in the valuation rule and again in NAV2's `RowRejectReason`. | Same strings by design; NAV2 reuses `isNavQualityEligible` for the quality test itself |
| D10 | `reportNavDependencyManifest` / `Integrity` / `Writer` keep a legacy basis value `twr_since_opening_balance` (a DB CHECK in 0172), allow-listed in the repo's TWRR guard. | Left as is (needs a migration to remove); NAV2 never writes it |
| D11 | `sip/sipXirr.ts` and the India MF report each build XIRR inputs for their own purposes. | Not audited in Stage 1 beyond confirming they call the one `xirr()` engine; NAV2 introduces no new solver |

## 4. Finding on scheme identity (decision for the PO)

**NAV2-F1.** `resolveScheme` (R2) tries the ISIN first and returns `resolved` as soon as one instrument matches, without checking that an AMFI scheme code on the same statement line agrees. A line carrying the direct-growth ISIN and the regular-growth AMFI code resolves, with confidence 1, to the direct-growth fund. Spec 4.3 orders AMFI code first and requires fail-closed behaviour on ambiguity. This is pinned by a characterisation test (`nav2IdentityAndCache.test.ts`) so it is not forgotten; the fix (return `ambiguous` when two exact identifiers point at different instruments) is a small change to certified code and is proposed for Stage 2 pending PO agreement. Not changed in Stage 1.

## 5. Not reused, and why

- The portfolio-level flow-adjusted index (`flowAdjustedIndexSeries.ts`) is an internal building block for portfolio risk cards (it adjusts a VALUE series for the investor's deposits); NAV2 scheme analytics use the scheme's own NAV series, which needs no flow adjustment. It stays internal and is not used.
- `analyticsOrchestrator.ts` / `PerformanceEngine.ts` (R4 / R11 portfolio analytics): NAV2 is a separate per-scheme contract; it does not alter or depend on them.
