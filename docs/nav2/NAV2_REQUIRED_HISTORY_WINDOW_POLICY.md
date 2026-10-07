# NAV2 - Required-history-window policy (Phase B)

Policy version `nav2-policy-v1` (`NAV2_POLICY.windowPlanning`). Code: `lib/engines/nav2/requiredWindowPlanner.ts` (pure), `lib/services/investment-intelligence/nav2/windowPlannerService.ts` (I/O through the existing loaders). Evidence label: code-complete / unit-tested.

## 1. Rule

For each HELD scheme, ONE consolidated range:

```
requiredFrom = earliest of all driver dates (each already reduced by its buffer), never before 01-04-2006 (the AMFI floor)
requiredTo   = the as-of date, never later than today (no future-dated NAV is ever requested)
```

The planner never defaults to scheme inception. The widest standard analysis reaches 1,855 days before the first analysis endpoint (the 5-year rolling horizon); anything earlier needs an explicit `analysisStart`.

## 2. Drivers and buffers (spec 5.1, 5.3)

`S` = the first date an analysis endpoint is wanted = `spec.analysisStart`, or the earliest held date when not given.

| Driver | Target date | Buffer before it | Source |
|---|---|---|---|
| Earliest canonical transaction / user investment date / holding snapshot | earliest held date | 10 days | spec 5.3 point-to-point boundary |
| Reconstruction buffer | earliest held date | 10 days | spec 5.1 "any mandatory reconstruction buffer" |
| Report as-of | the as-of date (capped at today) | 10 days | spec 5.2 |
| Point-to-point period | each selected period's start | 10 days | spec 5.3 |
| Rolling 1M / 3M / 6M / 1Y / 3Y / 5Y | `S` | 45 / 110 / 210 / 380 / 1,125 / 1,855 days | spec 5.3 |
| SMA over N observations | `S` | `ceil((N - 1) x 1.5)` + 10 days | spec 5.3; 1.5 calendar days per observation is PO-CONFIRM |
| EMA over N observations | `S` | `ceil((N - 1 + 20) x 1.5)` + 10 days | spec 5.3 "warm-up allowance for EMA"; 20 extra observations PO-CONFIRM |
| ROC over N observations | `S` | `ceil(N x 1.5)` + 10 days | spec 5.3 |
| Risk / benchmark measures | `min(S, analysisEnd - span)` | 10 days, where `span = ceil((returnsNeeded + 1) x 1.5)` and `returnsNeeded = max(30, 60 if risk, 60 if benchmark-relative)` | spec 11 minimums |

The risk driver is why a newly held scheme still gets enough history for volatility, Sharpe, beta and alpha: those are scheme-performance measures and must not depend on when the user bought. A scheme first held on 20-09-2026 is planned from 23-06-2026.

Every driver that set a date is recorded on the window (`kind`, `detail`, `targetDate`, `bufferDays`, `from`), so "why is this scheme being fetched back to this date?" always has an answer. Hand-checked examples (earliest transaction 10-01-2023, as-of 03-10-2026):

| Spec | Required from | Why |
|---|---|---|
| minimal (no horizons) | 31-12-2022 | earliest transaction minus 10 days |
| 1Y rolling only | 26-12-2021 | minus 380 days |
| standard (all six horizons, SMA 20/50/100/200, EMA 20/50, ROC 20, risk, benchmark) | 12-12-2017 | 5Y rolling, minus 1,855 days; 3,217 days of history in total |
| point-to-point from 15-06-2020 | 05-06-2020 | period start minus 10 days |

## 3. Triggers (spec 4.1)

`handleNav2Trigger()` is the single entry point; `classifyTrigger()` decides what each trigger means.

| Trigger | Action |
|---|---|
| statement accepted and certified | plan the user's held windows |
| a canonical transaction or holding introduces a newly held scheme | plan the user's held windows |
| a report requests an analysis period not yet covered | plan the user's held windows |
| the user changes the analysis period | plan the user's held windows |
| a NAV correction affects a scheme and date | invalidate only the dependents of that scheme and date (cache contract); no fetch |
| a benchmark mapping becomes active | record a benchmark-history requirement (benchmark history arrives by the governed BENCH-1 upload, not a NAV fetch) |
| a draft, rejected, quarantined, malware-failed, unresolved or unaccepted document | **ignore**: creates no requirement and no hold |

Requirements derive from CANONICAL rows only (usable transactions, user investment dates, holding snapshots: the existing loader excludes `reversed` and `review_required`). A source document that never produced canonical rows therefore cannot create a requirement. The existing acceptance trigger (migration 0168) creates a bounded 30-day retention hold only when a statement certifies; that is unchanged.

## 4. Execution: planner on top of the existing path, not a second system

1. `loadUserHeldFundDates` (extracted from `loadUserSchemeNeeds`, behaviour unchanged) reads the caller's own funds and each one's earliest held date.
2. `computeRequiredWindow` per scheme, `consolidateWindows` once.
3. `planFetches` applies the EXISTING `planSchemeGap` (covered when earliest stored NAV reaches the required date, clamped by the confirmed history floor; gap is `[required, earliest stored - 1 day]`), `inFailureCooldown`, `orderHydrationWork` (never attempted first, then least recently attempted) and `chunkDateWindow` (<= 730 days per provider request).
4. The plan's `requiredFromOverrides` go to `runUserNavHistoryBatch`, which already provides the adapter chain (AMFI primary, TIGZIG fallback), the attempt ledger, per-user rate limit, single-flight, audit, idempotent gap-only writes, newest-chunk-first and resumability. An override can only move a scheme's required date EARLIER than its own earliest-holding rule and only for the caller's own schemes.

## 5. Deduplication and tenancy

- Several statements, household members or triggers for the same scheme consolidate to one window (earliest `requiredFrom`, latest `requiredTo`, drivers merged); input order does not matter.
- A second user holding the same scheme finds the stored public NAV history and fetches nothing.
- A window carries no user, household, folio or document identifier.

## 6. No full-universe expansion

The candidate set is exactly the caller's held schemes. The planner never reads `ii_instruments` or `ii_prices_nav` itself, never imports the brute-force backfill, the scheduled job's candidate enumeration, or the benchmark dependency list (a static test pins this), and a test with 1,000 other instruments in the database and an override naming one of them shows only the user's schemes are planned, fetched and written.

## 7. Conflict with the NAV1 historical-depth policy - PO decision needed

`docs/nav1/NAV1_Historical_Depth_Policy.md` (PO decision 27-09-2026) says that for any protected scheme "hydrate and retain all reliably obtainable NAV history from scheme launch". The scheduled hydration job still does exactly that for every held scheme (`userHeldInstrumentsToDependencies` sets `historyCompleteness: null`, so the requirement is "from inception"), and retention (migration 0189) keeps a held scheme's entire history. NAV2 spec 5.1 says the opposite: do not hydrate back to inception unless explicitly required.

Stage 1 does not change the scheduled job or retention. The NAV2 planner is the bounded path for the user-triggered fetch only. Options for the PO: (a) keep the NAV1 policy for the scheduled fallback and treat NAV2's window as the minimum the analysis needs (nothing changes in storage); (b) change the scheduled job to the NAV2 window for held schemes (smaller storage; reverses the 27-09-2026 decision; the retention predicate would also need to change, which is a migration). Recommendation: (a) for Stage 2, revisit (b) with measured storage numbers from Stage 3.

## 8. Latest date and the daily job

The latest required date is the latest valid published NAV on or before the as-of date. The daily NAV job (migrations 0187 / 0205) keeps every live scheme current from the changeover date forward, independent of holdings; NAV2 does not fetch recent days for a held scheme. A held scheme whose newest NAV is old is shown with a stale-NAV disclosure by the valuation rule (7 days), not refetched by the planner.
