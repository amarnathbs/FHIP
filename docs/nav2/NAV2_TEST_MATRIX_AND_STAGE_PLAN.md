# NAV2 - Test matrix (spec section 17), certification table (section 22) and Stage plan

Branch `feat/nav2-stage1-engine-20261003`. Evidence label for every status below: **code-complete / unit-tested**. Nothing was run against DEV or production, no browser check was made, nothing was pushed or merged, no migration was applied or written.

Status words: COVERED = proven by the named Stage 1 test files at the level the row asks; PARTIAL = the pure or planner part is proven, the integrated part is not; DEFERRED = needs Stage 2 integration or Stage 3 DEV; DROPPED = removed by PO decision.

Independent oracle: `scripts/nav2_independent_oracle.py` (50-digit Decimal, imports no FHIP code) produced every expected number; closed forms are in the test comments. The spec's worked examples 1 (CAGR) and 3 (drawdown) are in the tests verbatim; examples 2 (value and correction) and 4 (joint 60 / 40) are in `nav2InvestorExperience.test.ts`.

## 1. The 50-row matrix

| N | Row | Status | Evidence and what remains |
|---|---|---|---|
| 1 | First accepted statement for a new scheme triggers bounded hydration | PARTIAL | `nav2WindowPlanner.test.ts`: trigger -> planned window -> existing fetch path, bounded requests for that scheme only. Wiring `handleNav2Trigger` into the accept / process routes is Stage 2 |
| 2 | Re-upload of the same statement is idempotent | PARTIAL | `nav2WindowPlanner.test.ts`: a repeat plan makes no provider request and adds no rows. Canonical-record idempotency is the existing suites; end to end is Stage 3 |
| 3 | Second user holding the same scheme reuses public NAV history without exposing tenancy | COVERED | `nav2WindowPlanner.test.ts`: one consolidated window, no fetch for user 2, neither user id in any plan |
| 4 | Rejected statement creates no lasting hydration requirement | PARTIAL | `nav2WindowPlanner.test.ts`: all six non-accepted states are `ignore`; review-required and reversed rows give no window. A real rejected document is Stage 3 |
| 5 | Unresolved scheme produces reconciliation, not guessed mapping | PARTIAL | `nav2IdentityAndCache.test.ts`: the resolver returns unresolved / ambiguous, never a guess, and every metric answers `identity_unresolved`. Reconciliation-case creation is existing code; finding NAV2-F1 recorded |
| 6 | Direct / regular and growth / IDCW never cross | COVERED | `nav2IdentityAndCache.test.ts` (resolver, series), `nav2TrendAndRanking.test.ts` (ranking groups), `nav2SeriesPreparation.test.ts` |
| 7 | Future-dated NAV excluded | COVERED | `nav2SeriesPreparation.test.ts` (with a control that shows the future row would have been used) |
| 8 | Wrong-currency NAV excluded | COVERED | `nav2SeriesPreparation.test.ts` |
| 9 | Corrected NAV replaces effective value and invalidates only dependencies | PARTIAL | `nav2SeriesPreparation.test.ts` (one effective value, both lineage forms), `nav2IdentityAndCache.test.ts` (selection of affected keys). The `ii_reference_corrections` listener that raises the event is Stage 2 |
| 10 | Weekend boundary chooses previous valid NAV and discloses actual date | COVERED | `nav2SchemeReturns.test.ts` (INR and AUD date formats) |
| 11 | Long gap yields insufficient-history state | COVERED | `nav2SchemeReturns.test.ts` (boundary, periodic measure, hydrating variant) |
| 12 | Absolute return formula matches hand calculation | COVERED | `nav2SchemeReturns.test.ts` |
| 13 | CAGR uses actual elapsed days | COVERED | `nav2SchemeReturns.test.ts` (731 days, 0.099926140350002860) |
| 14 | Rolling return produces multiple windows and correct summary | COVERED | `nav2SchemeReturns.test.ts` (1M and 3M windows against the oracle; summary; 1Y single window withheld) |
| 15 | Daily and log returns reconcile mathematically | COVERED | `nav2SchemeReturns.test.ts` |
| 16 | Sample standard deviation uses n - 1 | COVERED | `nav2SchemeRisk.test.ts` |
| 17 | Annualisation factor is correct and disclosed | COVERED | `nav2SchemeRisk.test.ts` (252 / 52 / 12; a mislabelled series is refused), `nav2ContractAndGuards.test.ts` (provenance) |
| 18 | Sharpe uses matched risk-free periodic returns | COVERED | `nav2RiskFreeDataset.test.ts` (step-function, conversion, series switch) |
| 19 | Sortino uses the declared downside convention | COVERED | `nav2RiskFreeDataset.test.ts` |
| 20 | Maximum drawdown peak / trough / recovery dates are correct | COVERED | `nav2SchemeRisk.test.ts` (spec example 3; not recovered; no drawdown) |
| 21 | Beta / alpha use aligned common dates | COVERED | `nav2SchemeRisk.test.ts`, `nav2RiskFreeDataset.test.ts` |
| 22 | Missing benchmark never produces zero beta / alpha | COVERED | `nav2SchemeRisk.test.ts` (ten blockers), `nav2ContractAndGuards.test.ts` |
| 23 | SMA / EMA warm-up rules hold | COVERED | `nav2TrendAndRanking.test.ts` |
| 24 | ROC uses the intended observation / calendar convention | COVERED | `nav2TrendAndRanking.test.ts` (observations) |
| 25 | Correlation uses returns, not NAV levels | COVERED | `nav2SchemeRisk.test.ts` (levels 0.9996, returns -1) |
| 26 | Ranking includes only comparable held schemes | COVERED | `nav2TrendAndRanking.test.ts` |
| 27 | High / low dates and median behaviour are deterministic | COVERED | `nav2TrendAndRanking.test.ts` |
| 28 | XIRR cash-flow signs and terminal value are correct | COVERED | `nav2InvestorExperience.test.ts` (Fixture C against the oracle) |
| 29 | XIRR failure / no-root state is honest | COVERED | `nav2InvestorExperience.test.ts` |
| 30 | TWRR passes an independent hand calculation | DROPPED | PO decision 03-10-2026: no time-based return anywhere; XIRR is the only personal return. The repo guard `noTimeWeightedReturnUserFacing.test.ts` stays green |
| 31 | Scheme CAGR and personal return remain separately labelled | COVERED | `nav2InvestorExperience.test.ts` (labels, keys, explanation) |
| 32 | Current value uses canonical units and eligible NAV | COVERED | `nav2InvestorExperience.test.ts` (engine; screen agreement is row 37) |
| 33 | Redeemed holding stays zero | COVERED | `nav2InvestorExperience.test.ts` |
| 34 | Joint ownership does not double count | PARTIAL | `nav2InvestorExperience.test.ts`: pure attribution (60 / 40 = 100%). Integrated holdings flow is Stage 2 |
| 35 | Entity-owned holding does not enter personal Net Worth | DEFERRED | Stage 2 (entity separation is applied where the holdings are loaded) |
| 36 | Manual investment path is untouched | DEFERRED | Stage 2: Stage 1 changes no manual-investment code; asserted by test once the integration exists |
| 37 | Dashboard, Holdings, Investments, Performance and Reports agree for the same as-of timestamp | DEFERRED | Stage 2 |
| 38 | Historical point-in-time report remains unchanged after newer NAVs | PARTIAL | the engine is deterministic and never uses a NAV after the as-of date (`nav2SeriesPreparation.test.ts`, `nav2ContractAndGuards.test.ts`); report level is Stage 2 |
| 39 | Finalised report remains immutable after correction | DEFERRED | Stage 2 (reports already store frozen output; NAV2 section must pin its provenance) |
| 40 | Cache invalidation cannot serve a stale value after successful correction processing | PARTIAL | `nav2IdentityAndCache.test.ts`: a correction changes the key, so the old entry is unreachable even before invalidation runs. The cache store is Stage 2 |
| 41 | Concurrent hydration creates no duplicate NAV rows | PARTIAL | planner deduplication (`nav2WindowPlanner.test.ts`); duplicate-proofing is the existing `unique (instrument_id, price_date)`, single-flight and ignore-duplicates writes. Live concurrency is Stage 3 |
| 42 | Failed provider call resumes without restarting completed work | PARTIAL | `nav2WindowPlanner.test.ts` (failure, cooldown, gap-only re-plan) on the existing path; live resume is Stage 3 |
| 43 | One failing instrument does not starve others | COVERED | `nav2WindowPlanner.test.ts` (fair order, cooldown, same-pass isolation) |
| 44 | RLS / authorisation blocks cross-tenant analytics access | DEFERRED | Stage 3: Stage 1 adds no table, endpoint or RLS policy |
| 45 | Logs contain no user holding lists or document PII | PARTIAL | `nav2ContractAndGuards.test.ts`, `nav2WindowPlanner.test.ts`: results, plans and keys carry no identifier. Log inspection is Stage 2 / 3 |
| 46 | Non-held scheme history is not accidentally hydrated | COVERED | `nav2WindowPlanner.test.ts` (1,000 other instruments, an override naming one, static import guard) |
| 47 | Daily current-NAV ingestion cannot reintroduce unlimited pre-policy history for non-held schemes | DEFERRED | the daily job is existing NAV1 code and untouched; Stage 3 storage evidence |
| 48 | Storage-growth metrics classify held history separately from all-live current data | DEFERRED | Stage 2 monitoring |
| 49 | Accessibility and mobile layout pass | DEFERRED | Stage 2 (UI) and Stage 3 (browser) |
| 50 | Production feature switch and rollback path work without deleting NAV data | PARTIAL | the risk-free master switch, the per-dataset flag and the refresh kill switch turn things off without deleting data (`nav2RiskFreeDataset.test.ts`, `nav2RiskFreeRefreshGate.test.ts`); the NAV2 feature switch is Stage 2 |

Count: COVERED 29, PARTIAL 12, DEFERRED 8, DROPPED 1.

## 1a. Negative controls demonstrably break something

A green control is indistinguishable from one that never applied, so `scripts/nav2_negative_control_mutations.py` removes one rule at a time and runs the owning test file. Result on this branch: **10 of 10 mutations were caught** (each reported at least one failing test, and the files were restored): future-dated NAV no longer excluded; risk-free staleness removed; parser / AI disagreement allowed to publish; EMA seeded with the first price; a rejected statement planning windows; CAGR on 365 instead of 365.2425; a missing benchmark no longer gating beta; the correlation deviation on a population denominator; invalidation reaching other schemes; the planner reaching back to the AMFI floor.

## 2. Spec 16 fixtures

| Fixture | Stage 1 | Notes |
|---|---|---|
| A simple growth scheme | PASS | A1 (spec example 1), A2 (12 NAVs: daily, log, high / low, mean, median, SMA, EMA, ROC), A3 (61 NAVs: volatility, drawdown), A4 (13 month-start NAVs: rolling) |
| B benchmark and risk-free | PASS | closed-form design (beta exactly 1.5, alpha 0.00055, rf exactly 0.0001 daily) plus the 50-digit oracle; T-bill versus repo; stepped yield |
| C user transactions | PASS (XIRR only) | three SIPs, a partial redemption, 205 units left; XIRR 0.2641093553074878 against scheme CAGR 0.1995; the time-based half is dropped |
| D correction | PARTIAL | engine part: one effective value, recalculation of the corrected scheme, unrelated scheme unchanged, key and invalidation selection. Finalised-report immutability and the report warning path are Stage 2 |
| E identity safety | PASS (plus finding NAV2-F1) | direct / regular, growth / IDCW, renamed, merged predecessor, unresolved and duplicate ISIN, no fuzzy matching |
| F gaps and boundaries | PASS | weekend, a 46-day gap, previous-valid-NAV, no interpolation, known coverage-gap disclosure |
| G ownership and valuation | PARTIAL | pure parts: spec example 2, redeemed = 0, statement vs market label, joint 60 / 40. Entity exclusion, manual investment and cross-screen agreement are Stage 2 |

## 3. Section 22 certification table (state after Stage 1)

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Canonical scheme resolution | CONDITIONAL PASS | resolver behaviour tested; finding NAV2-F1 open; reconciliation flow E2E Stage 3 |
| 2 | User-held-only hydration trigger | CONDITIONAL PASS | planner and trigger classification proven; route wiring Stage 2 |
| 3 | Required-window precision | CONDITIONAL PASS | policy, buffers and hand-checked dates proven; precision against real fetches is Stage 3; NAV1 inception-policy conflict needs a PO decision |
| 4 | Provider fidelity and correction handling | CONDITIONAL PASS | read-side handling and the in-place correction finding done; correction listener Stage 2 |
| 5 | Absolute / CAGR returns | PASS (unit level) | CAGR convention differs from the Performance tab: PO decision |
| 6 | Rolling / point-to-point returns | PASS (unit level) | |
| 7 | Daily / log returns | PASS (unit level) | |
| 8 | Volatility | PASS (unit level) | |
| 9 | Sharpe / Sortino | CONDITIONAL PASS | maths and contract proven; no risk-free data exists yet (storage and upload Stage 2); definitions differ from R4 |
| 10 | Maximum drawdown | PASS (unit level) | |
| 11 | Beta / alpha | CONDITIONAL PASS | maths and gates proven; BLOCKED for real numbers until a licensed or approved benchmark series exists |
| 12 | SMA / EMA / ROC | PASS (unit level) | |
| 13 | User-held rankings / comparability | PASS (unit level) | category source for ranking is a Stage 2 loader |
| 14 | User-held correlations | PASS (unit level) | |
| 15 | High / low / mean / median | PASS (unit level) | |
| 16 | XIRR separation and correctness | PASS (unit level) | the time-based half is dropped by PO decision |
| 17 | Current value / current NAV consistency | CONDITIONAL PASS | the certified rule is reused and tested; cross-screen agreement Stage 2 |
| 18 | Joint / entity / manual / redeemed handling | CONDITIONAL PASS | joint and redeemed (pure) proven; entity and manual Stage 2 |
| 19 | Historical and finalised-report immutability | NOT STARTED (Stage 2) | engine is deterministic and as-of bounded |
| 20 | BENCH-1 / risk-free governance | CONDITIONAL PASS | contracts, gates, switch, step-function and staleness rules, freshness signal and the weekly-refresh publication gate done and tested; storage, upload, refresh job and data are Stage 2; RBI's missing reuse licence is a PO-accepted risk, not a confirmation |
| 21 | Data-quality / unavailable states | PASS (unit level) | typed states, no value on unavailable |
| 22 | Cache invalidation and idempotency | CONDITIONAL PASS | key and selection contract proven; store Stage 2 |
| 23 | Concurrency / resumability / fairness | CONDITIONAL PASS | planner side proven; live Stage 3 |
| 24 | RLS / privacy / audit | CONDITIONAL PASS | no identifiers in results / plans / keys; RLS and audit for new endpoints Stage 2 / 3 |
| 25 | UI / accessibility / mobile | NOT STARTED | Stage 2 / 3 |
| 26 | Storage and non-held-history controls | CONDITIONAL PASS | planner side proven; storage evidence Stage 3 |
| 27 | DEV end-to-end accepted-statement journey | NOT STARTED | Stage 3 |
| 28 | Production deployment and scheduled-run evidence | NOT STARTED | Stage 4 / G |
| 29 | Recovery / rollback readiness | NOT STARTED | Stage 2 designs the switch, Stage 3 proves it |
| 30 | Remaining PO decisions | OPEN | listed in the Stage 1 report |

Overall: no section 22 item is a full PASS (as the spec requires: a full pass needs DEV and production evidence). The verdict `NAV2 USER-HELD ANALYTICS - FULL PASS` is NOT claimed.

## 4. Stage 2 plan (integration, Reports-menu report, UI)

1. **Premium gate and entitlement.** A Premium-only Reports-menu report ("Fund analytics for your held schemes"): server-side `canViewPremiumReport` on the page, the API and the report generation; free users get an explicit denial (401 / 403 style) and an upsell, never an empty page.
2. **Loaders (read-only, user-scoped).** Held schemes with plan / option / category / ownership split; NAV rows by instrument id; known coverage gaps into `prepareSeries`; benchmark segments through `loadBenchmarkAccess` + `clampToScope` + the category reference; the selected risk-free dataset through `selectRiskFreeSupply`; the user's canonical flows and `valueHoldingAsOf` input. One service function per report section that calls `computeHeldSchemeAnalytics`.
3. **Wire the triggers.** Replace the bare `kickUserNavHistory(userId)` in the accept / process routes and the report NAV gate with a planner-driven runner built on `handleNav2Trigger` (feature-flagged, default off); add the analysis-period-changed and report-period-requested triggers; add the `ii_reference_corrections` listener that raises `nav_correction` events.
4. **Risk-free storage, admin upload and the weekly refresh job** (migrations 0260 or higher; hand over as files, apply nothing): tables and the SECURITY DEFINER commit RPC with a new named capability (the design in the dependency register, section 4), loading the PO's first-load CSVs; then the weekly refresh job (section 5 of that register): `CRON_SECRET`-protected cron route, kill-switch row `nav2_risk_free_weekly_refresh` in `ii_reference_job_control` shipped OFF, dry-run mode, a polite fetcher (descriptive User-Agent, at most 4 requests, 4 s apart, conditional requests, robots.txt, hard caps, no PDFs, no human-verification bypass), the deterministic parser first and the AI schema extraction as fallback and second opinion, publication through the Stage 1 gate (`decideTbillRefresh`, `decideRepoRefresh`), an admin review queue with the evidence, per-observation provenance, gap rows for no-accepted-bids weeks, the NSDP-driven repo check that advances the verified-through date, and the admin freshness signal. Parser tests use fake HTML SYNTHESISED from the real release structure (nothing from RBI committed).
5. **Cache store** and its invalidation worker keyed by `buildResultCacheKey` / `selectInvalidated`; invalidation lag monitor.
6. **Report pinning**: the finalised section stores the result provenance (series checksum, policy and definition versions, benchmark and risk-free dataset versions) and the dependency manifest; later corrections raise an alert or a new report version, never a silent change.
7. **UI** (spec 13): period selectors, status tags for every typed state with the exact wording (`History is being prepared`, `Insufficient history`, `Statement value`, `Stale NAV`, `Benchmark mapping missing`, `Risk-free data unavailable`, `Data under review`, `Not comparable`), actual-dates and as-of disclosures, plain-language scheme-versus-your-return explanation, charts that break at material gaps, keyboard-accessible tables, mobile focused comparison (no large matrix). Dates `dd-mm-yyyy` (INR) / `dd/mm/yyyy`.
8. **Entity and ownership**: joint attribution once, Trust / HUF / Company excluded from personal Net Worth (existing `ownerClassScope`), manual investments untouched; tests for matrix rows 34-37.
9. **Monitoring** (spec 15): accepted-awaiting-hydration, age, provider errors, stale held schemes, calculation failures by typed reason, benchmark / risk-free coverage, cache lag, storage split (matrix 48).
10. **Fix NAV2-F1** if the PO agrees; align or label the CAGR conventions (D1); decide D2.
11. Feature switch with a tested off path that deletes no NAV data (matrix 50).

Stage 2 stop-gate: PO review. Stage 3 (DEV): the 18-point-style journey with synthetic fixtures only, exact mutation ledger, RLS and cross-tenant proof, browser evidence for every state, load and storage evidence. Stage 4 (production): allowlisted pilot behind the switch.
