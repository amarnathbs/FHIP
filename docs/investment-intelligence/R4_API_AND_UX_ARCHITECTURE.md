# R4 — API / Service Architecture and Performance UX

Covers spec sections 60-67 and 103-105. Written during the R4 continuation
pass (2026-08-20), which added the service, API and UX layers on top of the
already-certified calculation core delivered at `27bd370`.

## 1. Layering

```
                    pure, independently certified (unchanged this pass)
  xirr.ts  twrr.ts  navReturn.ts  riskMetrics.ts  benchmarkEngine.ts  rollingReturns.ts
        |            |             |                |                    |
        +------------+-------------+----------------+--------------------+
                                   |
                    bounded engine services (added this pass)
    PerformanceEngine.ts   benchmarkService.ts   riskMetricsService.ts   rollingReturnService.ts
                                   |
                         analyticsOrchestrator.ts        <- single entry point, pure
                                   |
                      analyticsRepository.ts             <- the ONLY I/O boundary
                                   |
        app/api/investment-intelligence/analytics/{route.ts, recalculate/route.ts}
                                   |
                       components/.../PerformanceClient.tsx
```

Two invariants hold across the whole stack:

1. **No formula is implemented twice.** The services orchestrate; they never
   re-derive a return. The single deliberate exception is the independent
   oracle (`scripts/ii_r4_independent_reconciliation.py` and the independent
   implementations inside `scripts/ii_r4_live_dev_security_tests.mjs`), which
   exist precisely so production can be contradicted.
2. **Everything above `analyticsRepository.ts` is pure.** `runAnalytics()`
   performs no I/O, so it is fully deterministic and directly unit-testable.

### 1.1 A filesystem hazard worth recording

The repo is developed on Windows, where the filesystem is case-insensitive.
`BenchmarkEngine.ts` and `benchmarkEngine.ts` resolve to the **same file**.
During this pass a service file named `BenchmarkEngine.ts` silently
overwrote the certified `benchmarkEngine.ts` primitives; it was caught by
`git status` showing the primitives file as modified, and restored from
git before anything downstream consumed it.

Service filenames are therefore lexically distinct from the primitive they
wrap (`benchmarkService.ts`, not `BenchmarkEngine.ts`), and each service
file carries a header comment saying why. Do not "tidy" these names into
PascalCase.

## 2. Calculation-result status vocabulary

`lib/engines/investment-intelligence/calculationStatus.ts` defines the
seven statuses required by spec section 104 and the deterministic mapping
from each engine's own `reason` union onto them.

| Status | Meaning |
| --- | --- |
| `CALCULATED` | A real, reproducible number from sufficient certified input. |
| `INSUFFICIENT_HISTORY` | Not enough certified history to support the metric. |
| `MISSING_REFERENCE_DATA` | NAV / benchmark series / mapping / risk-free rate absent. |
| `STALE` | Previously persisted; inputs or engine version have since moved. |
| `FAILED` | Attempted and errored. Never shown as a number. |
| `NOT_APPLICABLE` | Meaningless for this scope (e.g. active return with no benchmark concept). |
| `AMBIGUOUS` | No defensible single answer (e.g. multiple IRR roots). |

The structural guarantee is in the type, not in a convention: the
constructors for every non-`CALCULATED` status (`missingReferenceData`,
`insufficientHistory`, `failed`) do not accept a value, and
`fromXirr`/`fromTwrr`/`fromRiskMetric` only attach a value on the `ok`
branch. A suppressed metric is therefore **incapable** of carrying a
number, which is what makes "never a silent 0.00%" enforceable rather than
aspirational. `isDisplayableNumber()` is the single gate the UI consults.

`STALE` deliberately **retains** its value so the UI can say "as
previously calculated on <date>" — disclosure, not deletion.

## 3. Currency treatment (spec section 59)

`runAnalytics()` groups schemes by `currencyCode` and returns **one
portfolio block per currency**. There is no combined figure anywhere in
the result set, and no code path that converts a beginning or ending value
at today's FX rate.

When more than one currency is present, `crossCurrency` carries a
`NOT_APPLICABLE` outcome whose detail explains that a genuine
cross-currency return needs a historical FX return series, which this
release does not have. The UI renders that explanation above the
per-currency blocks.

Covered by `SVC-ORCH-001`, which also asserts that no `combined` key
exists on the result set.

## 4. History-completeness gating, end to end

R2's certified `history_completeness` reaches the engine through
`ii_portfolio_truth_status`. Where a user holds the same instrument across
several accounts, `weakestCompleteness()` selects the **least** complete
status — never the most flattering one.

`dataQuality.sinceInceptionXirrEligible()` then gates the since-inception
XIRR label, and `PerformanceEngine` suppresses the figure entirely for
anything other than `complete_from_inception`. `SVC-ORCH-002` verifies
both directions: suppressed for `partial_history`, calculated for
`complete_from_inception` on an otherwise identical fixture.

## 5. Reference-data quality gating

The repository excludes, rather than silently consumes, reference data
that is flagged:

* `ii_prices_nav.quality_status <> 'ok'` — excluded, with a disclosed warning.
* `ii_benchmark_series.quality_status <> 'ok'` — excluded.
* `ii_instrument_benchmarks.quality_status = 'ambiguous'` — excluded, with a
  warning; an ambiguous mapping must never quietly drive a comparison.
* `ii_instrument_benchmarks.quality_status = 'superseded'` — excluded.

In `benchmarkService.computeBlendedBenchmark`, an instrument whose
benchmark is missing **or** whose benchmark series lacks a boundary value
is counted as *uncovered* (`hasBenchmarkMapping: false`). It is never
assigned a 0% period return. Coverage therefore genuinely falls, and below
`MIN_COVERAGE_FOR_CONCLUSION` (80%) the certified primitive suppresses the
conclusion outright. `SVC-BENCH-003` and `SVC-BENCH-004` cover both paths.

A PRI series standing in where a total return is required is flagged
(`SVC-BENCH-005`), never silently substituted.

## 6. API surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/investment-intelligence/analytics` | GET | Retrieve derived results for the session user. |
| `/api/investment-intelligence/analytics/recalculate` | POST | Recompute and persist to `ii_analytics_results`. |

### 6.1 Parameter-spoofing defence (spec section 96)

Neither route accepts an identifying parameter. The only identity used is
`user.id` from `requireUser()`. The GET route takes `from`/`to` date bounds
only — pure period bounds that cannot widen data visibility — and rejects
anything that is not `YYYY-MM-DD`, plus inverted ranges. The POST route
takes **no input at all** and ignores any request body.

There is consequently no household, account, instrument or benchmark id
for a caller to spoof: the attack surface is removed by construction
rather than validated away.

### 6.2 Error handling (spec section 105)

Both routes wrap the whole pipeline in try/catch and return an explicit
error. A failure never degrades into a partially-populated or
zero-valued result that a caller could mistake for a real calculation.
Reference-data gaps are handled one level lower, in the repository, where
they become disclosed `warnings` plus suppressed metrics rather than a 500.

## 7. Persistence model

`toPersistableRows()` flattens a result set into `ii_analytics_results`
rows. Three properties matter:

* Every row carries `engine_version`, `metric_version`,
  `input_snapshot_version` (a sha256 of canonicalised inputs),
  `nav_data_version`, `benchmark_data_version`,
  `benchmark_mapping_version` and `risk_free_version`.
* **Unavailable metrics are persisted too**, with `quality_status =
  'unavailable'` and their `quality_reason`. The absence of a number is
  itself an auditable fact, not a gap in the table.
* `persistAnalyticsRows()` overwrites `user_id` on every row with the
  server-resolved id, so a caller cannot attribute rows to another user
  even by accident.

Writes use the service-role client because the table deliberately has no
authenticated-role insert policy. See `R4_SECURITY_VERIFICATION.md` §3 for
the migration defect that currently prevents this property from holding in
DEV.

Determinism and staleness are covered by `SVC-ORCH-004`: identical inputs
produce an identical fingerprint; changing any input (including a
reference-data version string) changes it; and `applyStaleness()` flips a
matching-value outcome to `STALE` when the fingerprint has moved.

## 8. Performance UX

`app/(app)/investment-intelligence/performance/page.tsx` +
`components/investment-intelligence/PerformanceClient.tsx`.

| Spec requirement | Where |
| --- | --- |
| Portfolio performance dashboard | `PortfolioSection` — TWRR, XIRR, blended benchmark, active return. |
| Scheme performance table with progressive disclosure | `SchemeTable` / `SchemeDetail` — collapsed row, expandable per-scheme detail. |
| Performance-vs-benchmark chart | `PerformanceVsBenchmarkChart` — both series rebased to 100. |
| Drawdown chart | `DrawdownChart`. |
| "How this was calculated" | `CalculationDetails` — period, frequency, contributing benchmarks and their TRI/PRI type, coverage %, risk-free rate and source, every engine version, and the input fingerprint. |

### 8.1 The single rendering gate

`MetricValue` is the only component that turns a metric into pixels. It
renders a number **only** for `CALCULATED` or `STALE`; otherwise it renders
the status label plus the engine's own explanation. There is no fallback
`?? 0` anywhere in the component tree.

`connectNulls={false}` on the benchmark line means a benchmark gap is drawn
as a gap, not interpolated across. When no benchmark exists at all, the
chart says so instead of drawing a flat zero line.

All charts set `isAnimationActive={false}`, consistent with the existing
project fix for blank charts in PDF rendering.

### 8.2 Insight classification (spec section 65)

Every narrative string on the page is an OBSERVATION (what the number
describes) or EDUCATION (what the measure means) item. Examples:

* "TWRR measures how the underlying investments performed, independent of
  when you added or withdrew money. XIRR measures your own outcome…"
* "This describes past variability; it is not a forecast."

There is no recommendation, no buy/sell/switch/rebalance guidance, and no
ranking that implies an action. The page header states plainly that the
figures are not advice and not a forecast.

## 9. Read-only guarantee

Static verification over every file added in this pass:

```
$ grep -rn "\.insert(\|\.update(\|\.upsert(\|\.delete(" <all new R4 files>
analyticsOrchestrator.ts:259:  flowMap.delete(terminal);        <- JS Map, not a DB call
analyticsRepository.ts:358:    .upsert(scoped, { onConflict: ... })  <- ii_analytics_results only
```

Every table reachable from R4 code:

```
ii_analytics_results   (write: derived analytics only)
ii_benchmark_series    (read)
ii_holding_snapshots   (read)
ii_instrument_benchmarks (read)
ii_instruments         (read)
ii_portfolio_truth_status (read)
ii_prices_nav          (read)
ii_risk_free_rates     (read)
ii_transactions        (read)
```

No FHIP financial register (`investments`, `assets`,
`retirement_accounts`, `income`, `expenses`, `liabilities`) and no R3
publication table appears anywhere. R3's own regression pack (136 tests
across 7 files) re-passes unchanged.
