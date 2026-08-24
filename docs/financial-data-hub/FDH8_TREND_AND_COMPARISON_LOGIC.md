# FDH-8 — Trend & Comparison Logic

## Trend (spec 50-53)

`getTrend()` buckets a user's APPROVED transactions by `transaction_date.slice(0, 7)` ('YYYY-MM', `monthBucketKey()` in `period.ts`) per currency, then calls `computeApprovedFinancialSummary` once per (currency, month) bucket — exactly the same oracle used for Overview, just invoked on a narrower slice each time. Each `TrendPoint` carries `incomeTotal`/`expenseTotal`/`netCashFlow`/`transactionCount` for that month. This is **historical actuals only**: there is no code path in `getTrend()` that projects, extrapolates, or reads a date beyond the requested period's `to` — grep-verified, no forecasting library or trend-fitting call exists anywhere in `lib/financial-data-hub/analytics/`.

## Rendered on Overview

`page.tsx` (Overview) renders a "Monthly trend" section: a fixed trailing 6-month window (`resolvePeriod('6_months', todayIsoDate())`), deliberately independent of the page's own period selector (a trend is a distinct capability from "totals for the selected period", spec 50), using the reused `TrendLineChart` component plus an adjacent semantic `<table>` (month/income/expenses/net cash flow) as the chart's required text-data summary (spec 102-104). Fetched as an independent, best-effort call — a trend-query failure does not blank the correct Income/Expenses/Net Cash Flow cards above it (spec 109).

## Category trend

Not built as a separate function in this pass — the same `getSpendingBreakdown`/`getIncomeBreakdown` shape, called once per period, is the mechanism a UI would use to build a category trend by calling it across multiple periods. A dedicated `getCategoryTrend()` convenience function was not added in this session (Open Residual — the composition is possible today with existing functions, just not pre-packaged as one call).

## Period-over-period comparison (spec 55-56)

`comparePeriods(current, previous, metricLabel, previousPeriodLabel)` in `periodComparison.ts` is the single function every comparison in FDH-8 must go through. Rules, each certified with a specific test case in `fdh8FinancialIntegrityCertification.test.ts`:

| Input shape | Output |
|---|---|
| `previous = 0`, `current > 0` | `percentChange: null`, label "New \<metric\> this period — none recorded \<period\>" |
| `previous = 0`, `current = 0` | `percentChange: null`, label "No \<metric\> recorded this period or \<period\>" |
| `current === previous` (both nonzero) | `percentChange: 0`, "No change" |
| `current > previous` | positive `percentChange`, "X% higher than..." |
| `current < previous` | negative `percentChange`, "X% lower than..." |

`percentChange` is `number | null` — never `Infinity`, never `NaN`. The type signature itself makes rendering a bad value a compile error at the call site if a component forgot to handle `null`.

## Partial period handling (spec 56)

`resolvePreviousPeriod(current, today, mode)` in `period.ts` detects `currentPeriodIsPartial` (the current period's `to` is after `today`) and, in its default `'equivalent_elapsed'` mode, truncates the comparison period to the SAME number of elapsed days rather than comparing "this month so far" to a full prior month. `currentPeriodIsPartial` is returned explicitly so the UI can render the disclosure ("comparing the first N days of each period") regardless of which mode is used — the spec's alternative ("or explicitly disclosed as different") is satisfied by always surfacing this flag, even when equivalent-elapsed truncation is applied.

## Average spending (spec 56)

Not implemented as a dedicated function in this pass. `TrendPoint.transactionCount` alongside `expenseTotal` gives a UI everything it needs to compute and explicitly label "per month" or "per transaction" averages without ambiguity, but FDH-8 does not itself compute or render an "average spending" figure in this session's UI build — deferred, disclosed as an Open Residual rather than risking an ambiguously-labelled number.

## Timezone safety (spec 24, 94)

`resolvePeriod`/`resolvePreviousPeriod` take `today` as an explicit ISO date string parameter — there is no `new Date()`/`Date.now()` call anywhere inside `period.ts` (grep-verified). The one place "now" is read is `requestParams.ts#todayIsoDate()`, which calls `new Date().toISOString().slice(0, 10)` — i.e. always the UTC calendar date, matching `transaction_date`'s own timezone-free `DATE` column type. A transaction dated the last calendar day of a month is included by the inclusive `to` boundary regardless of what wall-clock hour the request happens to run at.
