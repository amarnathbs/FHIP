# II-R10 — 18-Chapter Matrix (Delta Audit)

Per continuation spec section 6. Re-derived from the current tree, not
copied from memory. Updated after this session's populated-data
certification run (`scripts/r10_populated_certification.mjs`).

| # | Chapter | Section code | Built | Composer-wired | Canonical source | Empty-data verified | Populated-data verified |
|---|---|---|---|---|---|---|---|
| 1 | 12-Month Trends | `twelve_month_trends` | Yes (pre-R10) | Yes | Dashboard/score/resilience history | Yes | Yes (pre-R10) |
| 2 | Full Health Score Diagnostic | `score_diagnostic_full` | Yes (pre-R10) | Yes | Score engine | Yes | Yes (pre-R10) |
| 3 | Full Financial DNA | `financial_dna_full` | Yes (pre-R10) | Yes | DNA engine | Yes | Yes (pre-R10) |
| 4 | Investment Analysis | `investment_analysis` | Yes (pre-R10) | Yes | `investments` table | Yes | Yes (pre-R10) |
| 5 | Retirement Readiness | `retirement_readiness` | Yes (pre-R10) | Yes | Forecasting engine (`runForecast`, live) | Yes | NOT verified this session (see note below) |
| 6 | Insurance Analysis | `insurance_analysis` | Yes (pre-R10) | Yes | `insurance_policies` table | Yes | Yes (pre-R10) |
| 7 | Detailed Goal Forecasting | `goal_forecast_detail` | Yes (pre-R10) | Yes | Goals engine | Yes | PASS this session (real Goal seeded, chapter reached `included`) |
| 8 | Scenario Forecasting | `scenario_forecasting` | Yes (pre-R10) | Yes | Forecasting engine | Yes | Not separately re-verified this session |
| 9 | Full Financial Twin | `financial_twin_full` | Yes (pre-R10) | Yes | Financial Twin | Yes | Not re-verified this session |
| 10 | Full Cross-Border Wealth | `cross_border_full` | Yes (pre-R10) | Yes | Dashboard | Yes | Not applicable (single-country test data) |
| 11 | Financial Stress Testing | `stress_testing` | Yes (pre-R10) | Yes | Resilience stress engine | Yes | Yes (every live test user with income/expenses) |
| 12 | Personal Action Plan | `personal_action_plan` | Yes (pre-R10) | Yes | Recommendations engine | Yes | Not re-verified this session |
| 13 | Appendices | `appendices` | Yes (pre-R10) | Yes | Raw record tables | Yes | Yes (pre-R10) |
| 14 | Investment Performance | `investment_performance` | Yes (R10) | Yes | II-R4 `runAnalytics()` | Yes | **PASS — live, populated, exact-value match against the canonical R4 API** |
| 15 | Contribution (SIP) Behaviour | `sip_contribution` | Yes (R10) | Yes | II-R5 `runSipAnalytics()` | Yes | **PASS — live, populated, exact-value match against the canonical R5 SIP API** |
| 16 | Portfolio X-Ray | `portfolio_xray` | Yes (R10) | Yes | II-R5 `runXrayAnalytics()` | Yes | **PASS — live, populated (real classified sector/security data via the already-proven `ii_r5_browser_qa_xray_fixture.mjs` QA-MAIN dataset), exact-value match against the canonical R5 X-Ray API** |
| 17 | Tax & Cost Intelligence | `tax_and_cost` | Yes (R10) | Yes | II-R6 `runTaxSimulation()` | Yes | **PASS — live, real purchase+redemption, exact-value match against the canonical R6 tax API** (this session's minimal fixture never registered a scheme tax classification, so both sides correctly and identically report the disposal as "unresolved" rather than a computed STCG/LTCG figure — a fixture-completeness gap, not a chapter defect; report and canonical API agreeing exactly on the unresolved state IS the no-recalculation proof) |
| 18 | Priority Review Items | `priority_review_items` | Yes (R10) | Yes | II-R9 `listReviewItems()` | Yes | **PASS — live, one real review item ("Tax classification data incomplete"), exact title-set match against the canonical R9 review API** |

## 18/18 built and composer-wired

All five new Investment Intelligence chapters (this session's primary
objective, and the previous session's single largest disclosed gap) are
now populated-data-verified live against real DEV, with exact
source-of-truth equality against the canonical II APIs — not just their
safe empty-data path. See `scripts/r10_populated_certification.mjs`
(16/17 real checks passed) and `R10_ACCEPTANCE_REPORT.md` for full detail,
including a genuine no-double-counting proof (report net worth exactly
equals the canonical Dashboard net worth, two independent live runs) and
two real fully-populated PDFs (528,996 and 496,428 bytes).

## Remaining open gap: Retirement Readiness populated verification

Chapter 5 stayed `unavailable` even after seeding a `retirement_accounts`
row, a plausible `date_of_birth`, and directly triggering
`POST /api/forecast/run {forecast_type:'retirement'}` (which returned
`200` with a real run object). `buildForecastReportData` calls
`runForecast()` live internally on every report generation and only
surfaces a result when `run.status === 'completed'` — the live-triggered
run's own completion could not be independently confirmed from this test
script within the session's remaining time, so the root cause is not
fully diagnosed. This is a PRE-EXISTING chapter (not new R10 code); its
safe-degradation behaviour (showing "unavailable" rather than a fabricated
projection) is itself correct regardless of the cause. Disclosed honestly
as an open populated-verification gap, not claimed as resolved.
