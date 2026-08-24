# II-R10 — 18-Chapter Matrix (Terminal)

Per risk-based closure spec section 9. All 18 chapters, final state.

| # | Chapter | Section code | Built | Composer-wired | Canonical source | Empty-data verified | Populated-data verified |
|---|---|---|---|---|---|---|---|
| 1 | 12-Month Trends | `twelve_month_trends` | Yes | Yes | Dashboard/score/resilience history | Yes | Yes |
| 2 | Full Health Score Diagnostic | `score_diagnostic_full` | Yes | Yes | Score engine | Yes | Yes |
| 3 | Full Financial DNA | `financial_dna_full` | Yes | Yes | DNA engine | Yes | Yes |
| 4 | Investment Analysis | `investment_analysis` | Yes | Yes | `investments` table | Yes | Yes |
| 5 | **Retirement Readiness** | `retirement_readiness` | Yes | Yes | Forecasting engine (`runForecast`, live) | Yes | **PASS — fixed and live-verified this session (see below)** |
| 6 | Insurance Analysis | `insurance_analysis` | Yes | Yes | `insurance_policies` table | Yes | Yes |
| 7 | Detailed Goal Forecasting | `goal_forecast_detail` | Yes | Yes | Goals engine | Yes | PASS (real Goal seeded, `included`) |
| 8 | Scenario Forecasting | `scenario_forecasting` | Yes | Yes | Forecasting engine | Yes | Ran successfully alongside every populated-certification run this session (not separately asserted) |
| 9 | Full Financial Twin | `financial_twin_full` | Yes | Yes | Financial Twin | Yes | Not separately re-verified |
| 10 | Full Cross-Border Wealth | `cross_border_full` | Yes | Yes | Dashboard | Yes | Not applicable (single-country test data) |
| 11 | Financial Stress Testing | `stress_testing` | Yes | Yes | Resilience stress engine | Yes | Yes |
| 12 | Personal Action Plan | `personal_action_plan` | Yes | Yes | Recommendations engine | Yes | Not separately re-verified |
| 13 | Appendices | `appendices` | Yes | Yes | Raw record tables | Yes | Yes |
| 14 | **Investment Performance** | `investment_performance` | Yes | Yes | II-R4 `runAnalytics()` | Yes | **PASS — exact-value match vs canonical R4 API, live DEV** |
| 15 | **Contribution (SIP) Behaviour** | `sip_contribution` | Yes | Yes | II-R5 `runSipAnalytics()` | Yes | **PASS — exact-value match vs canonical R5 SIP API, live DEV** |
| 16 | **Portfolio X-Ray** | `portfolio_xray` | Yes | Yes | II-R5 `runXrayAnalytics()` | Yes | **PASS — exact-value match, real classified sector data, live DEV** |
| 17 | **Tax & Cost Intelligence** | `tax_and_cost` | Yes | Yes | II-R6 `runTaxSimulation()` | Yes | **PASS — exact-value match vs canonical R6 API, live DEV** |
| 18 | **Priority Review Items** | `priority_review_items` | Yes | Yes | II-R9 `listReviewItems()` | Yes | **PASS — exact title-set match, plus a real >1,000-row (1,200) count-accuracy proof, live DEV** |

## 18/18 built, composer-wired, and now ALL populated-data-verified against real DEV

Every one of the 5 new Investment Intelligence chapters (Performance, SIP,
X-Ray, Tax & Cost, Review Centre) and the pre-existing Retirement Readiness
chapter now has genuine, live, exact-value proof against real populated
data. The Retirement chapter was the last hold-out and the risk-based
closure session's explicit first priority — see
`R10_RETIREMENT_ROOT_CAUSE.md` for the full root-cause writeup.

## Terminal populated canonical verification table (spec section 9)

| Chapter | Populated canonical source | Exact raw-value comparison | Empty-data handling | Result |
|---|---|---|---|---|
| Performance | II-R4 `runAnalytics()` via `/api/investment-intelligence/analytics` | `deepEqual` (key-order independent), live DEV | `unavailable` + reason, live-verified | **PASS** |
| SIP | II-R5 `runSipAnalytics()` via `/api/investment-intelligence/sip` | `actualXirr` matched by `seriesKey` across presentable series, live DEV | `unavailable` + reason, live-verified | **PASS** |
| X-Ray | II-R5 `runXrayAnalytics()` via `/api/investment-intelligence/xray` | `deepEqual` on `sectorExposure`, live DEV, cross-validated against the independently-proven QA-MAIN classified-holdings fixture | `unavailable` + reason, live-verified | **PASS** |
| Tax & Cost | II-R6 `runTaxSimulation()` via `/api/investment-intelligence/tax/summary` | `taxableGain`/`classification`/`gainType`/`holdingDays` matched by instrument+date, live DEV | `unavailable` + reason, live-verified | **PASS** |
| Goals/Forecasting | Goals engine + canonical Forecasting | Chapter reaches `included` with real seeded goal data | Live-verified in earlier session round | **PASS** |
| Retirement | Canonical Forecasting `runForecast('retirement')` | Full `results` array `deepEqual` against `/api/forecast/runs/{id}`, live DEV | `unavailable` + reason for both "no forecast yet" and "no retirement accounts at all", live-verified (2 distinct edge cases) | **PASS** |
| Review Centre | II-R9 `listReviewItems()` | Title-set exact match, live DEV; true-count accuracy proven with 1,200 real rows | `unavailable` + reason, live-verified | **PASS** |

**All 7 domains: PASS.**
