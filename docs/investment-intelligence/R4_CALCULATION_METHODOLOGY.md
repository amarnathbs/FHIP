# R4 — Calculation Methodology

Every formula implemented in R4 is documented here: name, purpose, exact
formula, inputs, sign convention, dates/frequency, annualisation,
minimum-history rule, benchmark/risk-free requirement, failure conditions,
display rounding, and method-version. No formula exists only in code — this
document and the corresponding source-file header comments are kept in
sync; the `*_METHOD_VERSION` string exported by each engine module is the
authoritative version identifier persisted with every result
(`ii_analytics_results.metric_version` / `engine_version`).

Source of truth for each formula is the named `.ts` file under
`lib/engines/investment-intelligence/`; this document is the narrative
companion, not a duplicate implementation.

## 1. XIRR (money-weighted / investor return)

- **File**: `lib/engines/investment-intelligence/xirr.ts`
- **Version**: `xirr-newton-bisection-v1`
- **Purpose**: answers "what return did this investor actually earn from
  their real cash-flow pattern" (spec section 5, Q1).
- **Formula**: solve `Σ CF_i / (1+r)^((date_i - date_0)/365) = 0` for `r`,
  where `date_0` is the chronologically earliest cash-flow date.
- **Sign convention**: purchases / SIP instalments = negative; redemptions,
  distributions received, and the current ending value (as a synthetic
  terminal flow) = positive.
- **Dates**: actual calendar days, never monthly-approximated periods.
- **Method**: safeguarded Newton-Raphson with a bisection fallback whenever
  a Newton step would leave the current bracket or fail to reduce it. The
  valid search domain is `r ∈ (-1, 100]` (10,000% ceiling), scanned on a
  fixed grid (dense from -80% to +300%, sparse beyond) for sign changes.
  Zero sign changes → `NOT_BRACKETED`. More than one *distinct* root
  (de-duplicated within 1e-6) → `MULTIPLE_ROOTS_AMBIGUOUS`, never silently
  resolved to one of them.
- **Precision**: internal rate tolerance `1e-9`, NPV relative-tolerance
  `1e-7` (relative to the largest absolute cash-flow magnitude), max 100
  iterations per bracket. Display rounding: 4 decimal places of the rate
  (2 decimal places of a percentage). Internal precision exceeds display
  precision by five orders of magnitude.
- **Minimum history**: ≥ 2 cash flows, at least one positive and one
  negative.
- **Failure conditions** (never a fabricated number): `ALL_SAME_SIGN`,
  `NO_TERMINAL_VALUE` (caller must append the ending-value flow before
  calling), `INVALID_DATES`, `INSUFFICIENT_HISTORY`, `NOT_BRACKETED`,
  `NO_CONVERGENCE`, `MULTIPLE_ROOTS_AMBIGUOUS`.
- **Since-inception eligibility gate** (separate from the arithmetic
  itself): a since-inception XIRR is only labelled authoritative when the
  position's R2 `history_completeness = 'complete_from_inception'`. See
  `dataQuality.ts::sinceInceptionXirrEligible`.

## 2. NAV point-to-point return / CAGR (scheme investment return)

- **File**: `lib/engines/investment-intelligence/navReturn.ts`
- **Version**: `nav-return-actual365-v1`
- **Purpose**: "how did the scheme perform, independent of investor
  timing" (spec section 5, Q2).
- **Formula**: point-to-point = `Ending/Beginning - 1`. CAGR =
  `(Ending/Beginning)^(1/years) - 1`.
- **Years convention**: `actual_days / 365` ("actual/365"), applied
  identically in production, the independent oracle, and every manual
  reconciliation fixture.
- **Annualisation boundary**: periods of `actualDays <= 365` are shown
  **non-annualised** (point-to-point %); periods of `actualDays > 365` are
  also annualised (CAGR). This boundary is enforced in exactly one place
  (`pointToPointReturn`) — `cagr()` is a thin, boundary-consistent wrapper
  and does NOT apply a different cutoff (a real off-by-one bug of this
  exact kind was found and fixed during R4 development — see
  `R4_50_CASE_CALCULATION_CERTIFICATION.md`).
- **Minimum history**: a valid beginning value `> 0`, valid dates,
  `endDate > beginDate`.
- **Failure conditions**: `INVALID_INPUT`, `ZERO_OR_NEGATIVE_BEGINNING_VALUE`,
  `INVALID_DATE_ORDER`.
- **Never used for**: irregular external cash flows (that is XIRR's job);
  CAGR is never substituted for a failed XIRR.
- **Calendar-year returns**: only for genuinely complete calendar years —
  a year is included only if a valuation exists on/before Dec-31 of the
  prior year AND on/before Dec-31 of the year itself AND at least one
  observation falls within the year. A fund's launch year is therefore
  correctly excluded as incomplete.
- **Trailing horizons**: 1M/3M/6M/1Y/3Y/5Y/7Y/10Y/since-inception,
  computed by locating the nearest available observation to each horizon
  boundary (see `PerformanceEngine.computeSchemePerformance`).

## 3. TWRR (portfolio-manager / time-weighted return)

- **File**: `lib/engines/investment-intelligence/twrr.ts`
- **Version**: `twrr-chain-linked-eod-v1`
- **Purpose**: "how did the manager perform, isolated from the investor's
  contribution/withdrawal timing" (spec section 5/6).
- **Formula**: standard chain-linked sub-period methodology. Sub-period
  boundaries are the union of {period start, every external-flow date,
  period end}. For sub-period `k`: `r_k = (V_end,k - CF_k) / V_start,k - 1`.
  `TWRR = Π(1 + r_k) - 1`.
- **Cash-flow timing convention (end-of-day)**: a reported valuation on a
  flow date is treated as **already including** that flow (i.e. the
  portfolio's total value AFTER the money moved). The engine subtracts the
  flow from the reported value to isolate the pre-flow (closing)
  sub-period value; the NEXT sub-period's opening value is the full
  reported (post-flow) figure. This is documented once, here, and applied
  identically by the independent oracle and every fixture — getting this
  backwards was the single most common authoring mistake during R4's own
  test-writing (7 of 15 initial TWRR unit tests were wrong until the
  convention was applied consistently; see `R4_TWRR_CERTIFICATION.md`).
- **No interpolation**: if a certified valuation is not available exactly
  at a required sub-period boundary, the engine returns `unavailable`
  (`MISSING_BOUNDARY_VALUATION`) rather than inventing one.
- **Minimum history**: ≥ 2 valuation points.
- **Never approximated** as `ending_value / total_contributions`.

## 4. Blended portfolio benchmark & active return

- **File**: `lib/engines/investment-intelligence/benchmarkEngine.ts`
- **Version**: `blended-benchmark-monthly-rebalance-v1`
- **Formula**: (1) resolve each holding's primary benchmark via the
  effective-dated mapping; (2) weights at each rebalance period's start;
  (3) aggregate holdings sharing a benchmark; (4)
  `R_blend,t = Σ w_i,t-1 × R_benchmark_i,t` (renormalised by covered weight
  so uncovered holdings don't silently drag the blend toward zero — see
  §5 coverage below); (5) rebalance monthly (`REBALANCE_FREQUENCY`,
  versioned, never silently changed); (6) chain-link
  `Π(1 + R_blend,t) - 1`.
- **Coverage**: `MIN_COVERAGE_FOR_CONCLUSION = 0.80`. Below 80% portfolio-
  value coverage by a valid benchmark mapping, the blended result and any
  active-return conclusion built on it are `unavailable`
  (`INSUFFICIENT_BENCHMARK_COVERAGE`) — never presented as if coverage
  were 100%.
- **Active return**: `Portfolio metric − Benchmark metric`, for the SAME
  metric family and SAME period only (`activeReturn(portfolioMetric,
  benchmarkMetric, metricFamily)` — `metricFamily` is a mandatory
  parameter specifically to make an incompatible comparison a compile-time
  and runtime-checked error, not a silent possibility). Never "Investor
  XIRR minus Benchmark CAGR."
- **TRI vs PRI**: `ii_benchmarks.return_type` and per-series
  `ii_instrument_benchmarks` mapping metadata record whether a benchmark
  is Total-Return or Price-Return; the engine never silently substitutes
  one for the other (enforced by data availability — see
  `R4_BENCHMARK_METHODOLOGY.md`).

## 5. Risk metrics

See `R4_RISK_METRICS_METHODOLOGY.md` for the full per-metric breakdown
(volatility, downside deviation, max drawdown, Sharpe, Sortino, beta,
regression alpha, tracking error, information ratio, upside/downside
capture, Calmar). Summary table:

| Metric | Formula | Frequency | Min. history | File |
|---|---|---|---|---|
| Volatility | `StdDev(periodic returns, sample n-1) × sqrt(periodsPerYear)` | caller-specified, documented per call | 12 obs | `riskMetrics.ts` |
| Downside deviation | as volatility, squared deviations below MAR (default 0/period) only | same | 12 obs | `riskMetrics.ts` |
| Max drawdown | `value_t / running_peak_t − 1`, worst episode | any | 2 points | `riskMetrics.ts` |
| Sharpe | `(annualised return − annualised risk-free) / annualised volatility` | same as volatility | 12 obs + risk-free | `riskMetrics.ts` |
| Sortino | `(annualised return − annualised target) / annualised downside deviation` | same | 12 obs + target | `riskMetrics.ts` |
| Beta | `Cov(fund, bench) / Var(bench)`, sample | aligned periodic | 12 obs | `riskMetrics.ts` |
| Alpha (regression) | `mean(fund excess) − beta × mean(bench excess)`, annualised geometrically | aligned periodic | 12 obs + risk-free | `riskMetrics.ts` |
| Tracking error | `StdDev(fund_t − bench_t) × sqrt(periodsPerYear)` | aligned periodic | 12 obs | `riskMetrics.ts` |
| Information ratio | `(mean(active) × periodsPerYear) / tracking error` (arithmetic annualisation — industry convention for THIS ratio specifically) | aligned periodic | 12 obs | `riskMetrics.ts` |
| Upside/Downside capture | compounded fund return over benchmark-positive (or -negative) periods ÷ compounded benchmark return over the same periods | aligned periodic | 3 periods/direction | `riskMetrics.ts` |
| Calmar | `Annualised Return / |Max Drawdown|` | n/a | 365 days + nonzero drawdown | `riskMetrics.ts` |

## 6. Rolling returns

- **File**: `lib/engines/investment-intelligence/rollingReturns.ts`
- **Version**: `rolling-return-monthly-endpoints-v1`
- Monthly rolling N-year windows, exact fund/benchmark-aligned end dates.
  Minimum 6 comparable windows before a beat-% is reported
  (`MINIMUM_OBSERVATIONS.rollingMinWindows`).

## 7. Data-quality vocabulary

`lib/engines/investment-intelligence/dataQuality.ts` defines the
UI-facing `DataQualityFlag` enum: `COMPLETE`, `PARTIAL_TRANSACTION_HISTORY`,
`NAV_HISTORY_INCOMPLETE`, `BENCHMARK_MAPPING_MISSING`,
`BENCHMARK_HISTORY_INCOMPLETE`, `RISK_FREE_DATA_MISSING`,
`INSUFFICIENT_HISTORY`, `OPTION_TOTAL_RETURN_UNAVAILABLE`,
`STALE_MARKET_DATA`, `PLAN_OPTION_MISMATCH`. Every engine-level
`unavailable` result maps onto one of these for display; none of them is
ever silently converted to `0` or `0.00%`.

## 8. Minimum-history configuration

`lib/config/investment-intelligence/minimumHistory.ts` is the single,
versioned (`min-history-v1`) source every engine consults — never a
scattered `if (history > 365)` inline check.

## 9. Calculation versioning

`lib/engines/investment-intelligence/analyticsVersioning.ts` assembles
`PERFORMANCE_ENGINE_VERSION` plus every sub-engine version into
`ENGINE_SUB_VERSIONS`, and provides `fingerprintInputs()` (SHA-256 over a
canonicalised, float-free JSON representation) and `isStale()`. See
`R1_DATABASE_SCHEMA.md`-style traceability, extended for R4 in migration
`0043_ii_r4_performance_benchmark_reference_data.sql`
(`ii_analytics_results`).
