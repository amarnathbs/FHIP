# NAV2 - Architecture and data-flow map (Stage 1)

Status: Stage 1 (spec Phases A, B, C). Evidence label for everything below: **code-complete / unit-tested**. Nothing here has been run against DEV or production, no migration was applied, and nothing was pushed.

Spec: `NAV2_User_Held_Scheme_Analytics_Implementation_Prompt_2026-10-03.md` (sections 1-23). PO amendments of 03-10-2026 are applied: no time-based return anywhere (XIRR is the only personal return); risk-free series = RBI 91-day T-bill cut-off yield (primary) and RBI policy repo rate (secondary), terms risk accepted by the PO, fed by a Stage 2 weekly refresh job (default off) plus admin upload; beta/alpha need a gated benchmark; Premium users only, as a separate report under the Reports menu (Stage 2); DEV writes and browser checks are Stage 3.

## 1. The one-paragraph picture

An accepted statement (or any canonical holding) makes a scheme "held". For each held scheme the **window planner** works out one consolidated range of NAV history the analysis needs (earliest holding date, selected periods, rolling horizons, moving-average warm-up, risk minimum span, each with a documented buffer) and hands it to the **existing user-scoped NAV fetch** (not a second fetch system). The fetched NAVs land in `ii_prices_nav` (public reference data, one row per scheme per date). The **series preparation** step turns the stored rows into one clean, validated, ascending series per scheme. Pure **scheme-performance** functions describe the fund's own NAV behaviour; pure **investor-experience** functions describe the user's own money (XIRR, value, invested, gain). The two families are separate types, separate labels, and never share a field. Every result is a typed state (`available` or one of eight unavailable states) with provenance, never a bare number.

## 2. Data flow, source to output

```
Statement upload ──► parse / review / accept ──► canonical rows
   (ii_source_documents)        (ii_transactions, ii_holding_snapshots,
                                 ii_investment_date_inputs)       [user_id scoped, private]
        │
        │  TRIGGER (spec 4.1): statement accepted | new holding | report period requested |
        │                      analysis period changed | NAV correction | benchmark mapping active
        ▼
 classifyTrigger()  ─── draft / rejected / quarantined / malware-failed / unresolved / unaccepted ──► ignore
        │ plan_held_windows
        ▼
 loadUserHeldFundDates()          reads ONLY the caller's own canonical rows (user_id = caller)
        ▼
 computeRequiredWindow()  per scheme, from the AnalysisSpec + central policy  (pure)
        ▼
 consolidateWindows()     one window per instrument; carries no user / household / document id
        ▼
 planFetches()            compares with stored coverage (ii_prices_nav earliest, ii_nav_history_floors),
                          attempt ledger (ii_nav_hydration_attempts, 0198/0199), cooldown, fair order, chunking
        ▼
 runUserNavHistoryBatch(requiredFromOverrides)   <-- the EXISTING path: adapter chain (AMFI primary,
        │                                            TIGZIG fallback), single-flight, rate limit, audit,
        │                                            idempotent gap-only writes, newest-chunk-first
        ▼
 ii_prices_nav            public NAV rows: provider in data_version, record_checksum, import_batch_id,
        │                 quality_status, correction columns, price_date <= today+1 trigger
        ▼
 prepareSeries()          per scheme: only this instrument, this currency, valid date, not future,
        │                 price > 0, quality ok, one effective value per date, conflicts quarantined;
        │                 records first/last/count, material gaps, checksum
        ▼
 ┌──────────────── scheme_performance family ───────────────┐    ┌──── investor_experience family ────┐
 │ point-to-point, absolute, CAGR (365.2425, actual days)   │    │ XIRR (certified R4 engine)         │
 │ daily simple / log, rolling (6 horizons)                 │    │ current value (valueHoldingAsOf)   │
 │ volatility, Sharpe, Sortino, max drawdown                │    │ invested, received, gain / loss    │
 │ beta, Jensen alpha   (need gated benchmark + risk-free)  │    │ statement value kept separately    │
 │ SMA, EMA, ROC, high / low, mean / median NAV             │    └────────────────────────────────────┘
 │ correlation + ranking among HELD schemes only            │
 └──────────────────────────────────────────────────────────┘
        ▼
 Nav2Result<T>  { state, value | reason+detail, provenance, disclosures }     (deterministic, no clock)
        ▼
 cache key (scope hash, instrument, metric + definition version, policy version, window,
            NAV-series checksum, benchmark / risk-free versions, transaction version, currency)
        ▼
 [Stage 2]  Reports-menu Premium report section, entitlement-gated; finalised report pins outputs
            and its dependency manifest (ii_report_nav_dependencies already exists)
```

## 3. Module map (Stage 1)

| Module | Role | Pure? |
|---|---|---|
| `lib/config/nav2/metricPolicy.ts` | the ONE versioned policy (`nav2-policy-v1`) and the metric definition register (ids, versions, formulas) | yes |
| `lib/config/nav2/riskFreeSeriesConfig.ts` | risk-free series descriptors (ids and cadence as in the PO's CSVs), master switch, terms status (`po_accepted_2026-10-03`) and note, attribution, weekly-refresh switch (default off); ships NO observation | yes |
| `lib/engines/nav2/types.ts` | `Nav2Result`, the eight unavailable states, reasons, disclosures, provenance | yes |
| `lib/engines/nav2/series.ts` | series preparation, window selection, boundary lookup, returns, resampling, alignment, continuity | yes |
| `lib/engines/nav2/schemeReturns.ts` | absolute, CAGR, point-to-point, daily / log, rolling | yes |
| `lib/engines/nav2/schemeRisk.ts` | volatility, Sharpe, Sortino, drawdown, beta, alpha, correlation | yes |
| `lib/engines/nav2/schemeTrend.ts` | SMA, EMA, ROC, high / low, mean / median | yes |
| `lib/engines/nav2/riskFree.ts` | governed risk-free dataset contract, validation, step-function lookup (weekly auction / policy change), conversion, matching, freshness signal | yes |
| `lib/engines/nav2/riskFreeRefreshGate.ts` | the weekly-refresh PUBLICATION GATE (contract for Stage 2): parser / AI agreement, price recompute, plausibility, NSDP cross-check, gap rows, repo evidence, run planning, fetch politeness constants | yes |
| `lib/engines/nav2/benchmarkGate.ts` | benchmark gating for beta / alpha (reuses `segmentGateFailure`) | yes |
| `lib/engines/nav2/heldRanking.ts` | ranking among held schemes, comparable groups only | yes |
| `lib/engines/nav2/investorExperience.ts` | XIRR (R4 engine), value, invested, gain; family labels | yes |
| `lib/engines/nav2/analysisSpec.ts` | the one description of "what analysis is wanted" (drives both planner and metrics) | yes |
| `lib/engines/nav2/requiredWindowPlanner.ts` | Phase B: required window, consolidation, trigger classification | yes |
| `lib/engines/nav2/analyticsContract.ts` | the service contract a report section calls | yes |
| `lib/engines/nav2/cacheKeys.ts` | cache key + invalidation contract | yes |
| `lib/services/investment-intelligence/nav2/windowPlannerService.ts` | Phase B I/O: plan from the caller's held schemes, fetch plan, trigger entry point | I/O via the existing loaders |

No NAV2 module reads a clock (`Date.now()` / `new Date()`); the as-of date and today are arguments. A test pins this.

## 4. The two result families (spec 2)

| | scheme_performance | investor_experience |
|---|---|---|
| Describes | the fund's own adjusted NAV series | the user's own units and dated cash flows |
| Depends on contribution dates / amounts | never | always |
| Metrics | point-to-point, absolute, CAGR, rolling, daily / log, volatility, Sharpe, Sortino, drawdown, beta, alpha, SMA / EMA / ROC, correlation, ranking, high / low / mean / median | XIRR, current value, invested, received, gain / loss |
| Label printed with it | "Scheme CAGR (the fund's own growth, not your personal return)" | "Your return (XIRR, based on when your own money went in and came out)" |
| Type | `SchemePerformanceFamily` | `InvestorExperience` |

`computeHeldSchemeAnalytics()` returns both with the plain-language explanation of why they differ. A test asserts neither family carries the other's keys.

## 5. Typed result states (spec 11)

`available`, `insufficient_history`, `history_hydrating`, `benchmark_missing`, `risk_free_missing`, `currency_mismatch`, `identity_unresolved`, `data_quality_hold`, `not_applicable`. An unavailable result has **no `value` key at all** (the type forbids it), so no state can render as `0` or `0%`. Each carries a machine `reason` and one plain sentence. Dates inside sentences are day-first (INR `dd-mm-yyyy`, otherwise `dd/mm/yyyy`) through `formatDateShort`; a test scans every sentence for an ISO date.

## 6. Privacy and tenancy (spec 14)

- Window planning reads only `user_id = caller` canonical rows (the existing loader). No NAV2 module enumerates instruments, benchmarks, or the AMFI universe.
- A window, a fetch plan, a cache key and a ranking contain instrument ids, dates and driver kinds. They contain no user, household, folio or document identifier. The household scope enters a cache key only as a one-way hash, and scheme-performance keys carry no scope.
- Correlation and ranking take the caller's held-set as input and refuse a scheme outside it (`scheme_not_held_in_scope`).
- Stage 2 must still prove RLS and service-role scoping end to end (matrix rows 44, 45).

## 7. Where each spec section lands

| Spec | Stage 1 artefact |
|---|---|
| 4 triggers | `classifyTrigger`, `handleNav2Trigger` (entry point exists; **route wiring is Stage 2**) |
| 5 windows | `computeRequiredWindow`, policy buffers, `docs/nav2/NAV2_REQUIRED_HISTORY_WINDOW_POLICY.md` |
| 6, 7 source / lineage / preparation | `prepareSeries`, `docs/nav2/NAV2_SOURCE_AND_LINEAGE_MATRIX.md` |
| 8 metrics | `schemeReturns`, `schemeRisk`, `schemeTrend`, `heldRanking`; register in `NAV2_METRIC_DEFINITION_REGISTER.md` |
| 9.1, 9.2 | `investorExperience` (reuses `valueHoldingAsOf`, `xirr`); 9.3 dropped by PO |
| 10 benchmark / risk-free | `benchmarkGate`, `riskFree`; `NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER.md` |
| 11 completeness policy | `metricPolicy.ts`, typed states |
| 12 storage / cache | `cacheKeys.ts` (contract only; the cache store is Stage 2) |
| 13 UI | disclosures and plain sentences are produced here; the UI is Stage 2 |
| 15 monitoring | Stage 2 |
| 16, 17 fixtures / matrix | `tests/unit/nav2/*`, `NAV2_TEST_MATRIX_AND_STAGE_PLAN.md` |

## 8. Stage 2 module map (Fund analytics report, integration, admin)

Everything in Stage 2 sits AROUND the Stage 1 engine; the engine is unchanged except where noted. Evidence: unit-tested and PGlite-verified, not run on DEV.

| Area | Files |
|---|---|
| Report assembly (pure) | `lib/engines/nav2/fundAnalyticsReport.ts` (per-scheme blocks, compact stored trends, down-sampled chart with SMA 50 / 200, held rankings and pair correlations, scope notes, manifest and its checksum, shared-cache key); `lib/engines/nav2/presentation.ts` (how every typed state is shown); `analysisSpec.ts` (`reportAnalysisSpec`, the period choice) |
| Loaders (read-only, user-scoped) | `lib/services/investment-intelligence/nav2/fundAnalyticsLoader.ts` (composes `loadOwnerClassScopeForReport` and `loadAnalyticsDataset`; adds plan / option / category, raw NAV rows with lineage, open coverage gaps, the gate's hydration state, the declared benchmark segments, the risk-free dataset); `riskFreeDatasetLoader.ts` |
| Service | `fundAnalyticsReportService.ts` (switch, Premium, NAV gate, optional planner step, shared cache, pinned version and dependency manifest); `nav2ResultCacheStore.ts` (bundle cache and the correction worker); `nav2Flags.ts` |
| Integration with the existing fetch | `nav2TriggerRunner.ts` (the kick's default runner: planner when `nav2_trigger_planner` is on, the previous behaviour when off); `pc6/userNavHistoryKick.ts` now delegates to it |
| Customer surface | `app/(app)/reports/fund-analytics`, `app/api/reports/fund-analytics/**` (list, generate, read, export), `app/(print)/reports/fund-analytics/print`, `fundAnalyticsPdfRenderer.ts`, `components/reports/FundAnalyticsReport{View,Client}.tsx`; Reports menu entry |
| Risk-free | see the dependency register, section 7 |
| Admin | `lib/services/investment-intelligence/nav2/riskFreeAdmin*.ts`, `components/admin/RiskFreeDataClient.tsx`, `Nav2MonitoringClient.tsx`, `lib/admin/adminNav.ts`, `app/api/admin/me/route.ts`, `app/api/admin/investment-intelligence/nav2-monitoring` |
| Cron routes (both default OFF) | `app/api/investment-intelligence/cron/nav2-correction-worker`, `nav2-risk-free-refresh` |
| Database | migrations 0260, 0261, 0262 (hand-over; `po_apply_0260_0262/README.md`) |

Where Stage 2 reuses rather than rebuilds: `loadOwnerClassScopeForReport` (entity exclusion), `loadAnalyticsDataset` (flows, the one valuation rule, entitlement-gated benchmark series), `checkReportNavHistoryGate` and `kickUserNavHistory` (price-history readiness), `runUserNavHistoryBatch` (the fetch itself), `ii_reference_job_control` (every switch), the forecast report's PDF pattern (render token plus Playwright), the market-index admin pattern (capability column, predicate, SECURITY DEFINER commit function, append-only ledger), and the AIE gateway (the AI second opinion).
