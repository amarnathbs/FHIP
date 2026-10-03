# NAV2 - Test matrix (spec section 17), certification table (section 22) and Stage plan

Branch `feat/nav2-stage2-20261004` (from `feat/nav2-stage1-engine-20261003`, with origin/main merged in). Evidence labels used below, and nothing stronger:

- **unit-tested**: a vitest file in `tests/unit/nav2` (or an existing suite) proves it, one file at a time, against fakes and an in-memory database.
- **PGlite-verified**: `scripts/nav2_0260_0262_pglite_verification.mjs` replays the migration chain in an in-process Postgres with a platform shim (76 checks, all pass). That is a Postgres engine, NOT the DEV database.
- **NOT verified on DEV, on production, in a browser, or against the live RBI site.** Nothing was pushed or merged, no migration was applied, no database or DEV write was made, no request was sent to rbi.org.in.

Status words: COVERED = proven at unit / PGlite level by the named files; PARTIAL = the part this repository can prove is proven, the integrated or live part is not; DEFERRED = needs DEV (Stage 3); DROPPED = removed by PO decision.

Independent oracle: `scripts/nav2_independent_oracle.py` (50-digit Decimal, imports no FHIP code) produced every expected number of Stage 1. Stage 2 adds no financial formula; its numbers are counts, dates, digests and the existing engine's results.

## 1. The 50-row matrix (spec section 17)

| N | Row | Status | Evidence and what remains |
|---|---|---|---|
| 1 | First accepted statement for a new scheme triggers bounded hydration | PARTIAL | `nav2WindowPlanner.test.ts`, `nav2TriggerRunner.test.ts`: the kick the accept / process routes already call now runs the NAV2 plan when the `nav2_trigger_planner` switch is on (existing path untouched when off). Live fetch and route-level journey are Stage 3 |
| 2 | Re-upload of the same statement is idempotent | PARTIAL | `nav2WindowPlanner.test.ts`: a repeat plan makes no provider request and adds no rows. End to end is Stage 3 |
| 3 | Second user holding the same scheme reuses public NAV history without exposing tenancy | COVERED | `nav2WindowPlanner.test.ts` |
| 4 | Rejected statement creates no lasting hydration requirement | PARTIAL | `nav2WindowPlanner.test.ts`: all six non-accepted states are `ignore`. A real rejected document is Stage 3 |
| 5 | Unresolved scheme produces reconciliation, not guessed mapping | COVERED | `nav2IdentityAndCache.test.ts`. **NAV2-F1 is fixed** (an ISIN and an AMFI code that point at different instruments are now refused as ambiguous, which both production callers turn into an `ambiguous_instrument` reconciliation case); controls NC-F1; 53 suites that import the resolver re-run, the one failure (`statementResumeListAndApplyOnce`) is proven pre-existing |
| 6 | Direct / regular and growth / IDCW never cross | COVERED | `nav2IdentityAndCache.test.ts`, `nav2TrendAndRanking.test.ts`, `nav2SeriesPreparation.test.ts` |
| 7 | Future-dated NAV excluded | COVERED | `nav2SeriesPreparation.test.ts` |
| 8 | Wrong-currency NAV excluded | COVERED | `nav2SeriesPreparation.test.ts` |
| 9 | Corrected NAV replaces effective value and invalidates only dependencies | COVERED | `nav2SeriesPreparation.test.ts`, `nav2IdentityAndCache.test.ts`, `nav2CacheWorkerAndRiskFreeLoader.test.ts`, `nav2CorrectionWorkerRoute.test.ts` (the worker); the listener trigger on `ii_reference_corrections` is PGlite-verified (migration 0262) |
| 10 | Weekend boundary chooses previous valid NAV and discloses actual date | COVERED | `nav2SchemeReturns.test.ts` |
| 11 | Long gap yields insufficient-history state | COVERED | `nav2SchemeReturns.test.ts` |
| 12 | Absolute return formula matches hand calculation | COVERED | `nav2SchemeReturns.test.ts` |
| 13 | CAGR uses actual elapsed days | COVERED | `nav2SchemeReturns.test.ts` |
| 14 | Rolling return produces multiple windows and correct summary | COVERED | `nav2SchemeReturns.test.ts` |
| 15 | Daily and log returns reconcile mathematically | COVERED | `nav2SchemeReturns.test.ts` |
| 16 | Sample standard deviation uses n - 1 | COVERED | `nav2SchemeRisk.test.ts` |
| 17 | Annualisation factor is correct and disclosed | COVERED | `nav2SchemeRisk.test.ts`, `nav2ContractAndGuards.test.ts` |
| 18 | Sharpe uses matched risk-free periodic returns | COVERED | `nav2RiskFreeDataset.test.ts` |
| 19 | Sortino uses the declared downside convention | COVERED | `nav2RiskFreeDataset.test.ts` |
| 20 | Maximum drawdown peak / trough / recovery dates are correct | COVERED | `nav2SchemeRisk.test.ts` |
| 21 | Beta / alpha use aligned common dates | COVERED | `nav2SchemeRisk.test.ts`, `nav2RiskFreeDataset.test.ts` |
| 22 | Missing benchmark never produces zero beta / alpha | COVERED | `nav2SchemeRisk.test.ts`, `nav2ContractAndGuards.test.ts`. Beta and alpha are computed only on a DECLARED benchmark (PO decision: a category reference is refused unless the policy allows it, default off; control NC-K8) |
| 23 | SMA / EMA warm-up rules hold | COVERED | `nav2TrendAndRanking.test.ts` |
| 24 | ROC uses the intended observation / calendar convention | COVERED | `nav2TrendAndRanking.test.ts` |
| 25 | Correlation uses returns, not NAV levels | COVERED | `nav2SchemeRisk.test.ts` |
| 26 | Ranking includes only comparable held schemes | COVERED | `nav2TrendAndRanking.test.ts`, `nav2FundAnalyticsReport.test.ts` (the report's own rankings and pair list) |
| 27 | High / low dates and median behaviour are deterministic | COVERED | `nav2TrendAndRanking.test.ts` |
| 28 | XIRR cash-flow signs and terminal value are correct | COVERED | `nav2InvestorExperience.test.ts` |
| 29 | XIRR failure / no-root state is honest | COVERED | `nav2InvestorExperience.test.ts` |
| 30 | TWRR passes an independent hand calculation | DROPPED | PO decision 03-10-2026: no time-based return anywhere. `noTimeWeightedReturnUserFacing.test.ts` stays green, and the rendered report is asserted free of those words (`nav2ReportPresentation.test.ts`) |
| 31 | Scheme CAGR and personal return remain separately labelled | COVERED | `nav2InvestorExperience.test.ts`; the report view shows the two families in separate tables with the explanation sentence (`nav2ReportPresentation.test.ts`) |
| 32 | Current value uses canonical units and eligible NAV | COVERED | `nav2InvestorExperience.test.ts`; the loader passes the certified `valueSchemeAcrossFolios` result through unchanged (`nav2FundAnalyticsLoader.test.ts`) |
| 33 | Redeemed holding stays zero | COVERED | `nav2InvestorExperience.test.ts` |
| 34 | Joint ownership does not double count | PARTIAL | pure attribution (`nav2InvestorExperience.test.ts`) and the certified loader's own suites (`iiMultiFolioAggregation`, `iiOwnerClassBreakup`) which the loader reuses unchanged; not re-proved through the report. Integrated check is Stage 3 |
| 35 | Entity-owned holding does not enter personal analysis | COVERED | `nav2FundAnalyticsLoader.test.ts` (NC-D1): the loader runs on the non-entity scoped client; a trust-only fund is counted as excluded and disclosed on the report; a fund held both ways is not excluded |
| 36 | Manual investment path is untouched | COVERED | no manual-investment code is changed in this branch (`git diff` against origin/main touches none) and the loader writes nothing (`nav2FundAnalyticsLoader.test.ts` NC-D3) |
| 37 | Dashboard, Holdings, Investments, Performance and Reports agree for the same as-of timestamp | PARTIAL | the report consumes the same certified valuation as the other screens (`loadAnalyticsDataset`, `valueSchemeAcrossFolios`, unchanged); no cross-screen comparison test exists. Stage 3 |
| 38 | Historical point-in-time report remains unchanged after newer NAVs | COVERED | the loader reads NAV rows up to the as-of date only; the engine ignores later rows (`nav2SeriesPreparation.test.ts`); and the issued report is a pinned immutable row (S2-01) |
| 39 | Finalised report remains immutable after correction | COVERED | PGlite: the update trigger on `nav2_fund_analytics_reports` refuses every update; the service only inserts a NEW version (`nav2FundAnalyticsService.test.ts` NC-S4: no update or delete is ever issued); a correction raises an event and invalidates cache, never edits a report |
| 40 | Cache invalidation cannot serve a stale value after successful correction processing | COVERED | the key carries the series checksum (control S5 shows a stale hit appears when it is removed), the worker marks only affected entries (`nav2CacheWorkerAndRiskFreeLoader.test.ts`), an invalidated entry is never read |
| 41 | Concurrent hydration creates no duplicate NAV rows | PARTIAL | planner deduplication and the existing `unique (instrument_id, price_date)`; live concurrency is Stage 3 |
| 42 | Failed provider call resumes without restarting completed work | PARTIAL | `nav2WindowPlanner.test.ts`; the planner step in report generation holds only while a fetch could be started, and a failed attempt goes into the existing cooldown (`nav2FundAnalyticsService.test.ts` NC-S7); live resume is Stage 3 |
| 43 | One failing instrument does not starve others | COVERED | `nav2WindowPlanner.test.ts` |
| 44 | RLS / authorisation blocks cross-tenant analytics access | PARTIAL | PGlite: RLS on the pinned report (own rows only), no session write, token and cache tables unreadable by sessions; route tests prove every report route filters by the session user (S2-06). Live cross-tenant proof is Stage 3 |
| 45 | Logs contain no user holding lists or document PII | PARTIAL | results, plans, cache keys and the refresh report carry no identifier; routes log generic messages only. Log inspection is Stage 3 |
| 46 | Non-held scheme history is not accidentally hydrated | COVERED | `nav2WindowPlanner.test.ts` |
| 47 | Daily current-NAV ingestion cannot reintroduce unlimited pre-policy history for non-held schemes | DEFERRED | the daily job is existing NAV1 code and untouched; Stage 3 storage evidence |
| 48 | Storage-growth metrics classify held history separately from all-live current data | COVERED | PGlite: `nav2_monitoring_snapshot()` reports rows of held funds, rows of non-held funds from before the policy changeover, and the total, with the held-derived cells suppressed below 5; UI and route are unit-tested (`nav2RiskFreeAdminRoutes.test.ts`) |
| 49 | Accessibility and mobile layout pass | PARTIAL | the report renders real tables with captions and column scopes, a two-select pair picker (no matrix), `role="alert"` / `aria-live` states, touch-height controls, sideways-scrolling tables (asserted on server-rendered markup, `nav2ReportPresentation.test.ts`). No browser, screen reader or phone check was made: Stage 3 |
| 50 | Production feature switch and rollback path work without deleting NAV data | COVERED | four switches (`nav2_fund_analytics`, `nav2_trigger_planner`, `nav2_correction_worker`, `nav2_risk_free_weekly_refresh`) all ship disabled and fail closed; each off path does nothing and deletes nothing (`nav2FundAnalyticsService.test.ts`, `nav2TriggerRunner.test.ts`, `nav2CorrectionWorkerRoute.test.ts`, `nav2RiskFreeAdminRoutes.test.ts`); per-series switch with audit; the migrations' rollback notes are in the migration files |

Count: COVERED 38, PARTIAL 10, DEFERRED 1, DROPPED 1.

## 1a. Stage 2 supplementary rows (the new surfaces the spec's 50 rows do not name)

| Row | Behaviour | Status | Evidence |
|---|---|---|---|
| S2-01 | The issued report is a pinned, versioned, manifest-bearing output; its NAV range is protected from retention | COVERED | `nav2FundAnalyticsReport.test.ts`, `nav2FundAnalyticsService.test.ts`; PGlite (immutability, `pc6_nav_row_is_candidate()` = the 0219 body plus the pin, with a negative control against the 0219 body) |
| S2-02 | Rankings only among held comparable schemes; compact stored output; chart carries SMA 50 / 200 and keeps the true last NAV; deterministic | COVERED | `nav2FundAnalyticsReport.test.ts` |
| S2-03 | Premium only, explicit 403 on every report route, never an empty 200 | COVERED | `nav2FundAnalyticsRoutes.test.ts`, `nav2FundAnalyticsService.test.ts` |
| S2-04 | Switch off: nothing is loaded, written or deleted | COVERED | `nav2FundAnalyticsService.test.ts`, `nav2TriggerRunner.test.ts`, `nav2CorrectionWorkerRoute.test.ts` |
| S2-05 | Shared scheme-performance cache: exact reuse, no user scope, a changed series is a different key | COVERED | `nav2FundAnalyticsService.test.ts` (byte-identical stored JSON hit versus computed) |
| S2-06 | Another user's report is a 404 on list / read / export / print | COVERED | `nav2FundAnalyticsRoutes.test.ts`, `nav2FundAnalyticsService.test.ts` |
| S2-07 | A corrected NAV / benchmark / risk-free value invalidates exactly the entries it can affect; the worker is idempotent and switch-gated | COVERED | `nav2CacheWorkerAndRiskFreeLoader.test.ts`, `nav2CorrectionWorkerRoute.test.ts`; PGlite (listener) |
| S2-08 | The risk-free dataset version moves with any value, the verified-through date, the switch and the terms status | COVERED | `nav2CacheWorkerAndRiskFreeLoader.test.ts` |
| S2-09 | Unapplied or unreadable risk-free storage is "no dataset" with a reason, never a zero rate | COVERED | `nav2CacheWorkerAndRiskFreeLoader.test.ts` |
| S2-10 | The PO's two first-load CSV files load (quoted fields, both cadences, gap rows) | COVERED | `nav2RiskFreeCsvAndUpload.test.ts` (synthetic rows); **separately**, a temporary test parsed the PO's real files from `docs/nav2/risk_free_first_load/`: 1,060 of 1,060 and 61 of 61 rows accepted, 0 rejected, engine cleaning reported 0 issues (the test was deleted, no RBI data is committed) |
| S2-11 | An upload never changes a published value | COVERED | `nav2RiskFreeCsvAndUpload.test.ts`; PGlite (the function refuses a different value; a correction is the only way) |
| S2-12 | Commit is attested, hash-bound and runs on the caller's own session | COVERED | `nav2RiskFreeCsvAndUpload.test.ts`, `nav2RiskFreeAdminRoutes.test.ts` |
| S2-13 | Re-submitting the same file is a no-op; a verified-through confirmation on a re-submitted file moves forward only, audited | COVERED | `nav2RiskFreeCsvAndUpload.test.ts`; PGlite |
| S2-14 | Every typed unavailable state has its fixed headline ("History is being prepared", "Insufficient history", "Benchmark mapping missing", "Risk-free data unavailable", "Data under review", ...) | COVERED | `nav2ReportPresentation.test.ts` |
| S2-15 | Statement value and stale NAV are labelled beside the figure | COVERED | `nav2ReportPresentation.test.ts` |
| S2-16 | An unavailable result is never rendered as a number | COVERED | `nav2ReportPresentation.test.ts` |
| S2-17 | The chart breaks at a material gap and never joins across it | COVERED | `nav2ReportPresentation.test.ts` (row builder); the drawn chart itself is not browser-checked |
| S2-18 | No time-based-return wording and no ISO date in any rendered report text | COVERED | `nav2ReportPresentation.test.ts` |
| S2-19 | PDF: Premium and ownership are checked before any render token exists | COVERED | `nav2FundAnalyticsRoutes.test.ts`; the PDF itself was not rendered (no browser run) |
| S2-20 | Render token: single use, five minutes, one user, one report; unknown / malformed / expired refused | COVERED | `nav2FundAnalyticsRoutes.test.ts` |
| S2-21 | With the planner switch on, report generation plans the chosen period's history for the caller's schemes and holds only while a fetch was started | COVERED | `nav2FundAnalyticsService.test.ts`, `nav2TriggerRunner.test.ts` |
| S2-22 | A planning failure falls back to the existing fetch path and never blocks the report | COVERED | same |
| S2-23 .. S2-27 | RBI HTML readers: auction release read by column label, gap, layout change is null, NSDP latest week, month listing | COVERED | `nav2RbiHtmlReaders.test.ts` (synthetic pages of the structure seen in saved copies; **not re-read against the live site**) |
| S2-28, S2-29 | Polite fetcher (budget, spacing, UA, robots, HTML only, size cap, host lock) and a hard stop on a verification page | COVERED | `nav2RbiFetcher.test.ts` |
| S2-30 | Weekly refresh job: kill switch, dry run, publish only through the gate, review with evidence, gap rows, late release, idempotence, repo rules, fetch problems | COVERED | `nav2RiskFreeRefreshJob.test.ts`, `nav2RbiAiReaderAndRefreshRoute.test.ts`; PGlite (the job's exact payload shape, accept-from-review, verified-through) |
| S2-31 | The period choice sets the analysis window and bounds the history requested | COVERED | `nav2ReportAnalysisSpec.test.ts` |
| S2-32 | Non-fund holdings are excluded and counted | COVERED | `nav2FundAnalyticsLoader.test.ts` |
| S2-33 | Raw NAV lineage reaches the series; a fund still being fetched is `history_hydrating` | COVERED | `nav2FundAnalyticsLoader.test.ts` |
| S2-34 | Admin surfaces: two separately named risk-free capabilities and the PC6 capability for monitoring; four layers; explicit 401 / 403; fail closed | COVERED | `nav2RiskFreeAdminRoutes.test.ts` (direct API on every verb of every route, direct page, nav, `/api/admin/me`); PGlite (database layer: wrong capability, anon, ordinary user refused) |

## 1b. Negative controls demonstrably break something

A green control is indistinguishable from one that never applied, so a mutation script removes one rule at a time and runs the owning test file.

- Stage 1, `scripts/nav2_negative_control_mutations.py`: 10 of 10 caught.
- Stage 2, `scripts/nav2_stage2_negative_control_mutations.py`: **18 of 18 caught** (each reported at least one failing test; files restored): RBI figure read from the left edge; fetcher budget; fetcher spacing; fetcher 403 hard stop; cache key without the series checksum; Premium check removed; upload conflict blocker removed; dry run writes; kill switch ignored; risk-free API guard widened; trigger runner ignores the planner switch; an unavailable result shown as `0%`; entity-only funds not counted as excluded; manifest checksum ignoring the manifest; a switch read error counted as ON; correction events never marked processed; dataset version ignoring observations; print route using another user than the token's.
- Defects found BY the controls while they were being written (all fixed): a blank leading yield cell shifted the next column into the 91-day position, which would have published the 182-day yield (the right-aligned figure rule and a test now prevent it); a stored GAP with a value now on the release was not treated as a conflict by the Stage 1 gate (hardened and tested); the shared in-memory test double lacked `upsert` and `count` (added, additive).

## 2. Spec 16 fixtures

| Fixture | State | Notes |
|---|---|---|
| A simple growth scheme | PASS | Stage 1 |
| B benchmark and risk-free | PASS | Stage 1 (closed form plus the 50-digit oracle) |
| C user transactions | PASS (XIRR only) | Stage 1 |
| D correction | PASS at unit / PGlite level | engine part (Stage 1) plus the listener, the worker, the cache invalidation and the immutable pinned report (Stage 2) |
| E identity safety | PASS | Stage 1 plus the NAV2-F1 fix |
| F gaps and boundaries | PASS | Stage 1; the chart breaks at gaps (Stage 2) |
| G ownership and valuation | PARTIAL | pure parts and entity exclusion proven; cross-screen agreement and joint through the report are Stage 3 |

## 3. Section 22 certification table (state after Stage 2)

Evidence is unit-tested and PGlite-verified only. No item is a full PASS, because a full pass needs DEV and production evidence.

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Canonical scheme resolution | PASS (unit level) | NAV2-F1 fixed with named controls; reconciliation-case creation by both callers asserted; E2E Stage 3 |
| 2 | User-held-only hydration trigger | CONDITIONAL PASS | planner, trigger classification and the switch-gated runner proven; live fetch Stage 3 |
| 3 | Required-window precision | CONDITIONAL PASS | policy, buffers, hand-checked dates and the period-bounded request proven; real fetches Stage 3; NAV1 inception-policy conflict still needs a PO decision |
| 4 | Provider fidelity and correction handling | CONDITIONAL PASS | read-side handling, the listener (PGlite) and the worker (unit) done; live correction Stage 3 |
| 5 | Absolute / CAGR returns | PASS (unit level) | CAGR convention differs from the Performance tab: PO decision still open |
| 6 | Rolling / point-to-point returns | PASS (unit level) | |
| 7 | Daily / log returns | PASS (unit level) | |
| 8 | Volatility | PASS (unit level) | |
| 9 | Sharpe / Sortino | CONDITIONAL PASS | maths and contract proven; risk-free storage, upload and first-load format proven (the PO's real files parse); no data is loaded anywhere until the PO loads it on DEV |
| 10 | Maximum drawdown | PASS (unit level) | |
| 11 | Beta / alpha | CONDITIONAL PASS | maths and gates proven; computed only on a declared benchmark; BLOCKED for real numbers until an approved total-return series exists |
| 12 | SMA / EMA / ROC | PASS (unit level) | |
| 13 | User-held rankings / comparability | PASS (unit level) | category comes from the scheme master through the existing category reference |
| 14 | User-held correlations | PASS (unit level) | focused two-fund picker on screen, full pair list on the PDF |
| 15 | High / low / mean / median | PASS (unit level) | |
| 16 | XIRR separation and correctness | PASS (unit level) | |
| 17 | Current value / current NAV consistency | CONDITIONAL PASS | the certified rule is reused unchanged; cross-screen agreement Stage 3 |
| 18 | Joint / entity / manual / redeemed handling | CONDITIONAL PASS | entity exclusion and manual untouched proven; joint through the report Stage 3 |
| 19 | Historical and finalised-report immutability | PASS (PGlite and unit level) | pinned immutable rows, new versions, NAV range protected from retention |
| 20 | BENCH-1 / risk-free governance | CONDITIONAL PASS | storage, two-capability admin surface, attested upload, correction ledger, review queue, series switch, weekly refresh job (default OFF, dry run) all built and tested; the job's parsers are NOT verified against the live RBI site; RBI's missing reuse licence is a PO-accepted risk, not a confirmation |
| 21 | Data-quality / unavailable states | PASS (unit level) | fixed headlines for every state, rendered and asserted |
| 22 | Cache invalidation and idempotency | PASS (unit level) | shared bundle cache, exact reuse, correction worker |
| 23 | Concurrency / resumability / fairness | CONDITIONAL PASS | planner side proven; live Stage 3 |
| 24 | RLS / privacy / audit | CONDITIONAL PASS | RLS PGlite-verified; routes filter by session user; no identifiers in plans, keys or refresh reports; live proof Stage 3 |
| 25 | UI / accessibility / mobile | CONDITIONAL PASS | markup contract asserted on server-rendered output; no browser, no screen-reader, no phone check |
| 26 | Storage and non-held-history controls | CONDITIONAL PASS | monitoring snapshot (PGlite) and the retention pin; storage evidence Stage 3 |
| 27 | DEV end-to-end accepted-statement journey | NOT STARTED | Stage 3 |
| 28 | Production deployment and scheduled-run evidence | NOT STARTED | Stage 4 |
| 29 | Recovery / rollback readiness | CONDITIONAL PASS | four fail-closed switches with tested off paths; migration rollback notes; the real rollback is Stage 3 |
| 30 | Remaining PO decisions | OPEN | listed in the Stage 2 report |

The verdict `NAV2 USER-HELD ANALYTICS - FULL PASS` is NOT claimed.

## 4. Stage 3 plan (DEV)

1. PO applies migrations 0260, 0261, 0262 to DEV in that order (`docs/nav2/po_apply_0260_0262/README.md`), grants the capabilities, and uploads the two first-load CSVs through the admin screen.
2. A DEV dry run of the weekly refresh (switch on, `dryRun` left at its default) to compare the readers against the live pages, then the first live run only if the dry run's decisions are right.
3. A synthetic-fixture accepted-statement journey with the exact mutation ledger, RLS and cross-tenant proof, browser evidence for every state on desktop and a phone, a PDF export, and load and storage evidence.
4. Stage 4 (production): allowlisted pilot behind the switches.
