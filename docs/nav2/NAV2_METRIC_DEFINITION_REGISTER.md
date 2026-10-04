# NAV2 - Metric definition register

Policy version: `nav2-policy-v1`. Engine version: `nav2-engine-v1`. Source of truth in code: `lib/config/nav2/metricPolicy.ts` (`NAV2_POLICY`, `NAV2_METRICS`). A test fails if a metric id exists in code without a `###` section here, or the reverse.

Each metric below states: formula, conventions, minimum evidence, the typed states it can return, and its definition version. A definition version changes only when the **formula or convention** changes; a threshold change bumps the policy version instead. Both versions are in every result's provenance and every cache key.

Conventions common to all metrics:

- NAV observation = one effective value per scheme per date, valid ISO date, not after the as-of date, price greater than 0, in the scheme's currency, quality status `ok`, ascending. No forward-fill, no interpolation, ever.
- Floating point: arithmetic is IEEE double inside the engine. NAV and cash-flow money are parsed from their exact stored decimal strings at the boundary. Golden tests compare to a 50-digit Decimal oracle at relative tolerance 1e-11 to 1e-13; no rounding happens inside the engine (display rounding is the UI's job).
- Sample standard deviation divides by `n - 1` everywhere. A standard deviation at or below `zeroVarianceEpsilon` (1e-12) is treated as zero.
- Annualisation: daily x sqrt(252), weekly x sqrt(52), monthly x sqrt(12), only for a series whose intervals match the declared frequency (see `maxReturnIntervalDays`, `medianIntervalDays`). A weekly series declared daily is refused, never annualised with the wrong factor.
- Boundary rule: the latest valid NAV on or before the requested date, no more than `boundaryLookupDays` (10) earlier; the actual date used is returned and any substitution is disclosed.
- A window the history does not reach (first in-window NAV more than 10 days after the requested start, or last more than 10 days before the requested end) is `insufficient_history` / `window_not_covered`, never a shorter window under the requested label.
- A conflicting (quarantined) date inside the requested period is `data_quality_hold`.
- While a scheme's history is still being fetched, a lack of history is `history_hydrating`, never `insufficient_history`, and no interim figure is shown.

## Policy constants (all in `NAV2_POLICY`)

| Constant | Value | Origin |
|---|---|---|
| `daysPerYear` (CAGR) | 365.2425 | spec 8.2 |
| `cagrMinDays` | 365 | spec 8.2 "at least one year" |
| `boundaryLookupDays` | 10 | spec 5.3 |
| `materialGapDays` | 10 | PO-CONFIRM (spec says "material gaps", no number) |
| `periodsPerYear` | daily 252, weekly 52, monthly 12 | spec 8.7 |
| `maxReturnIntervalDays` | daily 10, weekly 14, monthly 45 | PO-CONFIRM |
| `medianIntervalDays` | daily 0-4, weekly 5-9, monthly 25-35 | PO-CONFIRM |
| `minimums.dailyReturnObservations` | 2 | spec 11 |
| `minimums.volatilityReturns` / preferred | 30 / 60 | spec 11 |
| `minimums.sharpeSortinoReturns` | 60 | spec 11 |
| `minimums.betaAlphaReturns` / preferred | 60 / 252 | spec 11 |
| `minimums.correlationReturns` / disclose below | 30 / 60 | spec 11 |
| `minimums.rollingMinWindows` / summary | 1 / 60 | spec 11 / **PO-CONFIRM (60)** |
| `minimums.drawdownObservations` / short period | 2 / 90 days | spec 11 / PO-CONFIRM |
| `rollingHorizons` | 1M, 3M, 6M, 1Y, 3Y, 5Y (calendar months 1, 3, 6, 12, 36, 60) | spec 8.5 |
| `rollingAnnualiseFromMonths` | 12 | PO-CONFIRM |
| `movingAveragePeriods` | 20, 50, 100, 200 observations | spec 8.13 |
| `rocMaxPeriod` | 1000 | PO-CONFIRM |
| `riskFreeMaxStalenessDays` | `RBI_91D_TBILL_CUTOFF_YIELD` 21 (from the last auction), `RBI_POLICY_REPO_RATE` 90 (from the verified-through date) | PO decision 03-10-2026 (21); repo 90 PO-CONFIRM |
| `windowPlanning.*` | see the window policy document | spec 5.3 |

## Scheme-performance family

### absolute_return
`P1 / P0 - 1` with `P0`, `P1` the latest valid NAV on or before the requested start and end. Returns actual dates, NAVs, offsets and `boundarySubstituted`. Not calculated when a boundary has no NAV within 10 days, the two ends resolve to the same NAV, or a NAV is not positive. Version `nav2-absolute-return-v1`. Hand check: 100 to 121 is 21%.

### cagr
`(P1 / P0) ^ (365.2425 / actualDays) - 1`, `actualDays` the calendar days between the two NAV dates actually used. Shown only when `actualDays >= 365`; under that the typed state is `not_applicable` / `period_under_one_year` and the absolute return is the figure to show. Labelled "Scheme CAGR (the fund's own growth, not your personal return)". IDCW and dividend options carry the NAV-only disclosure (distributions not added back). Version `nav2-cagr-actual-days-v1`. Spec example 1 (100 on 01-01-2023, 121 on 01-01-2025): 731 days, CAGR 0.099926140350002860 (oracle). **Differs from the R4 Performance-tab convention** (actual/365 gives 0.099856587738287252); see the reuse and duplicates document.

### point_to_point
Absolute return and CAGR for requested dates, with `requestedStart/End`, actual NAV dates, start and end NAV, offsets and a boundary-substitution disclosure ("Prices are not published every day: the start of 04-01-2025 had no published price, so 03-01-2025 was used"). Version `nav2-point-to-point-v1`.

### daily_simple_return
`r_t = P_t / P_(t-1) - 1` between CONSECUTIVE valid observations (Friday to Monday is one return of 3 days; no synthetic weekend days). Each row carries `intervalDays` and `spansMaterialGap`. Needs 2 observations. Cumulative simple return = product of `(1 + r_t)` minus 1. Version `nav2-daily-simple-return-v1`.

### daily_log_return
`g_t = ln(P_t / P_(t-1))`. Log returns are never summed and shown as a percentage: `cumulativeFromLogReturns = exp(sum g_t) - 1`, equal to the cumulative simple return (tested). Reported in the same result as the simple returns. Version `nav2-daily-log-return-v1`.

### rolling_return
For every end date `t` in the analysis window (one per available observation): the start is the latest valid NAV on or before `t` minus the horizon in calendar months (31 March minus 1 month is 28/29 February), within 10 days. Return is absolute for horizons under 12 months and CAGR (365.2425) from 12 months. Exposes horizon, observation frequency, first and last endpoint, window count, endpoints before the first window (history does not reach back that far: not a gap), endpoints skipped inside (a gap: `partial`), min, max, mean, median, share of positive windows. Summary statistics are withheld (with a disclosure) until there are at least 60 windows. A single trailing return is point-to-point, not rolling. Version `nav2-rolling-return-v1`.

### volatility
`sample_sd(simple returns) x sqrt(periodsPerYear)` at the declared frequency. Needs 30 returns, 60 preferred (below 60 a disclosure). Result states the convention ("sample standard deviation x sqrt(252) for daily returns"). A flat NAV has volatility 0, a valid figure. Version `nav2-volatility-v1`.

### sharpe_ratio
`mean(r - rf) / sample_sd(r - rf)` per period, and annualised `x sqrt(periodsPerYear)`. `rf` is the periodic risk-free return `(1 + y/100)^(1/N) - 1`, `N` = 252, 52 or 12 to match the return frequency, with `y` the annualised percent yield of the selected RBI series in force on each interval's START date (step function: latest observation on or before, never future, never interpolated, never older than the staleness constant). Needs 60 returns and a risk-free rate for at least 95% of them (the others are left out and counted; see the risk-free section). No ratio when the excess-return deviation is zero (`not_applicable` / `zero_volatility`). Without a series: `risk_free_missing`, never zero. Version `nav2-sharpe-excess-v1`. **Differs from R4** (annualised geometric return over annualised volatility).

### sortino_ratio
Target (MAR) = the matched risk-free return. `downside_deviation = sqrt(mean over ALL periods of min(0, r - MAR)^2)` (all periods in the denominator, population denominator `n`: the declared convention). `Sortino = mean(r - MAR) / downside_deviation`, annualised `x sqrt(N)`. No ratio when downside deviation is zero. Version `nav2-sortino-all-periods-v1`. **Differs from R4** (R4 divides by `n - 1` and uses a zero MAR by default).

### max_drawdown
`running_peak_t = max(P_0..P_t)`, `drawdown_t = P_t / running_peak_t - 1`, `max = min(drawdown_t)`. Returns peak date and NAV, trough date and NAV, recovery date (first observation after the trough at or above the prior peak), days peak to trough, days trough to recovery, and `recovered` / `not_recovered` / `no_drawdown`. Needs 2 observations; under 90 days a short-period disclosure. Computed by the certified R4 `maxDrawdown`. Version `nav2-max-drawdown-v1`. Spec example 3 (100, 120, 90, 108, 125): peak 120, trough 90, -25%, recovered at 125.

### beta
`cov(r_scheme, r_benchmark) / var(r_benchmark)` on COMMON dates only (the benchmark's extra days are dropped; a benchmark missing days leaves fewer common returns). Needs 60 common returns (252 preferred for a one-year claim). Benchmark gates (all must hold, else `benchmark_missing` with no number): a mapping effective for the WHOLE window and not changing inside it; entitlement allows calculation and display; catalogue verified; total-return series (a price index or unknown type is refused); published levels exist. A declared mapping wins over the read-time category reference; a category reference is allowed only through the same gates and carries its honest label ("Compared with the usual benchmark for X funds (not this fund's own declared benchmark)"). Zero benchmark variance: `not_applicable`. Beta arithmetic is the certified R4 `beta`. Version `nav2-beta-v1`.

### jensen_alpha
`alpha_periodic = mean(r_s) - [rf + beta x (mean(r_b) - rf)]`, `rf` = mean of the matched periodic risk-free returns; annualised ARITHMETICALLY (`alpha_periodic x periodsPerYear`), declared in the result. Not shown when beta is unavailable or the risk-free series is missing. Version `nav2-jensen-alpha-arithmetic-v1`. **Differs from R4** (geometric annualisation).

### sma
`mean(P_(t-N+1)..P_t)` over valid observations. N is a count of observations, not calendar days. Approved N: 20, 50, 100, 200. No value before N observations exist. Computed over the whole series (the warm-up uses earlier history); only points inside the requested window are returned. Version `nav2-sma-v1`.

### ema
`EMA_t = P_t x 2/(N+1) + EMA_(t-1) x (1 - 2/(N+1))`, SEEDED with the simple average of the first N observations at the N-th observation. No EMA before it. The planner requests N plus 20 extra observations of warm-up so the displayed values are not dominated by the seed. Version `nav2-ema-sma-seed-v1`.

### roc
`P_t / P_(t-N) - 1`, N valid observations (whole number, 1 to 1000). First value at observation N+1. Version `nav2-roc-observations-v1`.

### correlation
Pearson correlation of aligned periodic simple RETURNS (never NAV levels) between two schemes the caller states are held in scope. Needs 30 common returns, a prominent disclosure below 60. Zero variance on either side: `not_applicable`. A scheme outside the held set: `not_applicable` / `scheme_not_held_in_scope`. Version `nav2-correlation-returns-v1`.

### held_ranking
Rank of one metric among the household's OWN schemes. Label "Your held schemes". Comparable group = same category, plan, option, horizon, metric and metric definition version. A lone scheme in its group is "not comparable"; a scheme with an unavailable metric is listed as excluded; ties break by instrument id and are flagged. States the population size and the as-of date. Never a market ranking. Version `nav2-held-ranking-v1`.

### nav_extremes
Highest and lowest eligible NAV in the window with the EARLIEST date each occurred, the observation count and the actual period. Always carries the disclosure that NAV levels cannot be compared between schemes. Version `nav2-nav-extremes-v1`.

### nav_average
Arithmetic mean and median (mean of the two middle values for an even count) of the eligible NAVs, with count and observation frequency. Descriptive only. Version `nav2-nav-average-v1`.

## Investor-experience family

### xirr
The certified R4 solver (`xirr.ts`, `xirr-newton-bisection-v1`): `sum CF_i / (1 + x)^((date_i - date_0)/365) = 0`. Cash flows from canonical transactions: purchases negative, redemptions and cash distributions positive, plus the current value as the final positive flow on the valuation NAV's own date. Fails honestly: no valuation (`insufficient_history`), all one sign, no root, multiple roots (`not_applicable`), invalid dates (`data_quality_hold`). Never derived from NAV points alone. This is the ONLY personal return (PO decision: no time-based return). Labelled "Your return (XIRR, based on when your own money went in and came out)".

### current_value
`canonical units x latest eligible NAV`, by the certified `valueHoldingAsOf` rule: the NAV's own date, future / wrong-currency / invalid NAVs excluded, redeemed holdings exactly zero, statement value kept and labelled separately. Statement-only values carry a `statement_value` disclosure, stale NAVs a `stale_nav` disclosure.

### invested_amount
Sum of purchase flows, with the amounts received and the first investment date.

### gain_loss
`current value + amounts received - amounts invested`. Absolute, not annualised. Realised / unrealised split is Stage 2 (it reuses the existing India MF report lot engine).

## Risk-free dataset contract (spec 10, PO decisions of 03-10-2026)

Series: `RBI_91D_TBILL_CUTOFF_YIELD` (primary, cadence `weekly_auction`) and `RBI_POLICY_REPO_RATE` (secondary, cadence `policy_change`); ids and cadence words are those of the PO's first-load CSV files. Full register: `NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER.md`.

A governed dataset carries: series id and name, source ("Reserve Bank of India"), attribution text ("Source: Reserve Bank of India"), cadence, dataset version, retrieval date, `termsReviewStatus` (`po_accepted_2026-10-03`: the PO accepted that RBI publishes no explicit reuse licence, as a recorded risk; written confirmation is not required), `enabled` switch, `maxStalenessDays`, `verifiedThroughDate` (policy-change series), and observations (observation date, annualised yield in percent as published, source document, source URL, retrieval date, notes, entry kind, extraction provenance). A GAP row (an auction with no accepted bids) records that no value exists and never carries one.

Step-function semantics: the latest VALUE observation on or before the date; never a future one, never interpolated; for the weekly T-bill at most 21 days older than the date; for the repo rate (changes only) the date must be no later than `verifiedThroughDate` plus 90 days. A date with no fresh rate has no rate. Rule of 04-10-2026 (PO). A gap row means "no cut-off exists for that date" (reasons: `no_accepted_bids`, `no_auction_held`, `no_row_in_source`). The 21-day staleness window stays the general rule. A weekly rate also carries forward across DOCUMENTED gap rows for at most 35 calendar days from the last VALUE observation (`riskFreeGaps.maxCarryAcrossDocumentedGapDays`), and only while the records from that observation to the date (the value, each gap row, the date) are no more than 14 days apart (`documentedGapMaxRecordSpacingDays`): an undocumented hole never carries, and beyond 35 days the date has no rate. A carried rate is labelled "carried across a documented RBI gap" in the disclosure and in the provenance (`periodsCarriedAcrossDocumentedGap`, `documentedGapDatesCrossed`). Window-level rule (changed 04-10-2026; before it ONE date without a rate made the whole ratio `risk_free_missing`): a Sharpe, Sortino or alpha is computed over the return observations that HAVE a rate, provided at least 95% of the window's return observations do (`riskFreeGaps.minWindowCoverageShare`); below that, or with none, it is `risk_free_missing`. The number left out is disclosed (`risk_free_periods_excluded`) and stored in the provenance (`periodsExcluded`, `excludedDates`, `windowReturnCount`, `windowCoverageShare`). Alpha takes its means over the same kept observations; beta stays the one computed on every common return. The same states drive the admin freshness signal (`riskFreeFreshness`).

Validation drops, and reports, invalid dates, observations dated after their retrieval, yields outside 0-100 (a unit mistake), missing source documents, conflicting duplicates and malformed gap rows. The master switch is `NAV2_RISK_FREE_CONFIG.enabled`; it, the dataset's own flag, or a `declined` terms status makes every risk-free-dependent ratio `risk_free_missing` / `risk_free_series_disabled` without deleting anything.

Conversion, tested against hand-computed values: `rf_periodic = (1 + y/100)^(1/N) - 1`. A yield of 12.682503013196972% converts to exactly 1% monthly; 10.948521608698425% to 0.2% weekly; 2.5518911987697367% to 0.01% daily. At 5.5199%: 0.00021323453574782518 daily, 0.0010337912005306864 weekly, 0.0044874866412933080 monthly.

The provenance of every Sharpe, Sortino and alpha prints the series name, the yield at the start and end of the window, the dates of the auctions or decisions used, the number of return observations left out and the number carried across a documented RBI gap, the dataset version, the retrieval date, the terms status, the verified-through date, the staleness constant, the conversion and the attribution.

## PO-CONFIRM list (engineering choices where the spec is silent)

1. Risk-free periodic conversion `(1 + y)^(1/N) - 1` (frequency-matched) versus actual/365 per interval. Chosen: frequency-matched, as the PO's note suggests. Weekend-spanning daily returns therefore get the same periodic rate as weekday ones.
2. Alpha annualisation: arithmetic (periodic alpha times N), not R4's geometric.
3. Sortino denominator over all periods with `n`, not `n - 1`, not negative-only.
4. Rolling summary statistics need 60 windows.
5. `materialGapDays` 10, interval bands, drawdown short-period 90 days, ROC max 1000.
6. Repo-rate freshness window 90 days from the verified-through date (the weekly NSDP check advances it); the series records changes only.
7. CAGR uses 365.2425 whereas the existing Performance tab uses actual/365 (and benchmark window returns use 365.25): three conventions exist in the repository.
