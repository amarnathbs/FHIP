# II-R10 — Retirement Readiness Root Cause & Fix (Risk-Based Closure Hard Gate)

Per spec sections 4-8. This was executed first, before any other work this
session, per the spec's own explicit priority order.

## Symptom (as reported)

Real retirement account exists, plausible DOB exists, forecast endpoint
returns HTTP 200, Retirement Readiness chapter = `unavailable`.

## Root cause #1 — silent numeric overflow crash (the actual reported symptom)

`buildForecastReportData()` calls `runForecast(userId, {forecastType:
'retirement', retirementTargetMethod: 'desired_income',
retirementDesiredAnnualIncome: Math.max(1, dashboard.essentialMonthlyExpenses
* 12)}, supabase)` on every report generation (there is no cache — it is a
live call every time). `runForecast()` persists one row per forecast period
into `forecast_results`. That table's `variance_percentage` column is
`numeric(9, 4)` (max magnitude 99999.9999). Every forecast calculator
computes `variancePercentage = (actual - target) / target * 100`, guarded
only against `target <= 0` — never against `target` being a small-but-
positive degenerate value.

**Live-reproduced, exact values** (`scripts/r10_retirement_debug.mjs`,
disposable test user, real retirement account, real $60k/month essential
expense, real DOB): `target_value: 25` (a desired-income target computed
from a near-floor `desiredAnnualIncome`), `opening_value: 800000` →
`variance_percentage: 3220488.88` on period 1 alone. 466 of ~480 result
rows were similarly out of range. Postgres rejected the whole batch INSERT
with `numeric field overflow`. `runForecast()` correctly caught this,
marked the run `'failed'`, and re-threw. `forecastReportData.ts`'s
`safeRunDetail()` catches **every** exception by design (a category with
genuinely no data must not abort the whole report) and returns `null` —
so the chapter rendered `unavailable` with **no error surfaced anywhere**,
even though the retirement data and the forecast trigger were both present
and correct. This is exactly why the HTTP 200 / real DOB / real account
symptom looked contradictory: the bug lived three layers below any of
those checks, in a DB-level type-precision mismatch that every earlier
verification pass had no reason to look at.

### Fix

`lib/services/forecastData.ts` — a `safeVariancePercentage()` guard is
applied at the single shared persistence point used by **every** forecast
type (not just retirement), immediately before the `forecast_results`
insert: any `variance_percentage` whose magnitude would exceed the
column's own `numeric(9,4)` bound (or is non-finite) is stored as `null`
instead. This is a safe-persistence guard, not a recalculation — every
other field (`opening_value`, `closing_value`, `target_value`,
`variance_value`) is stored completely unchanged; only a percentage that
cannot fit its own column (and would not be a meaningful "N% funded"
figure to show a user even if it could) is suppressed, matching the exact
"don't show a nonsensical percentage" principle `reportNarrative.ts`'s
`computeMetricMovement()` already applies elsewhere in this codebase.

## Root cause #2 — found while building the RED→GREEN edge-case regression

Testing "no retirement accounts at all" (spec section 8's required edge
case) surfaced a second, related defect: a user with **zero** retirement
accounts still gets a `'completed'` forecast run (the calculator
legitimately projects a $0 balance staying $0 forever — that is not an
error), so `run.results.length === 0` alone never catches this case. The
chapter rendered `included` with a 466-row, entirely-$0 trajectory —
exactly the "zeros that look like calculated facts" spec section 28 rules
out, and a real fabrication risk (the chapter visually implies "you have a
tracked retirement position" when the user has none at all).

### Fix

`lib/engines/reportSectionsPremium.ts`'s `buildRetirementReadiness()` now
also requires `source.dashboard.hasRetirement` (an existing, already-
canonical boolean — `input.retirement.length > 0` — computed once in
`dashboardData.ts` and already used elsewhere for net worth). No new query,
no recalculation: reusing an existing canonical flag.

## RED → GREEN evidence (`scripts/r10_retirement_certification.mjs`, live DEV)

| Case | Scenario | Pre-fix | Post-fix |
|---|---|---|---|
| A | Valid retirement data, real (previously degenerate) desired-income target | `unavailable`, DB error silently swallowed | `included`, raw values exact-match the canonical forecast run (`report rows=466, canonical rows=466`, `deepEqual` true) |
| A (variance) | Every period's `variance_percentage` | overflow crashed the whole insert | every value now `null` or within `±99999.9999`, verified across all 466 rows |
| B | No retirement accounts at all | (not previously tested) would have rendered `included` with an all-$0 trajectory | correctly `unavailable`, "No retirement accounts are currently recorded" |
| C | Retirement account present, no DOB on file | (not previously tested) | reaches a defined state (`included`, using the timing-hierarchy's non-DOB fallback) — never a silent crash |

**8/8 real checks passed** on the final combined run (`RET-A1`-`RET-A4`,
`RET-B1`-`RET-B2`, `RET-C1`-`RET-C2`). All disposable test users and their
retirement accounts were deleted and independently re-verified: 0
leftover.

## Predecessor-regression note

`safeVariancePercentage()` is applied at the shared insert point for
**every** forecast type (net_worth, retirement, goal, debt, investment,
cross_border, resilience), not only retirement — any of those types could
theoretically hit the same class of overflow (a near-zero target relative
to a large actual value) and would previously have failed silently the
same way. This session's live testing exercised net_worth, goal, debt,
investment, cross_border and resilience forecasts indirectly on every
populated-certification run (they all run in parallel inside
`buildForecastReportData`'s own `Promise.all`) with no observed
regression, but no dedicated overflow-scenario test was built for those
other six types specifically — disclosed as an intentionally bounded scope
(the reported defect was retirement-specific; the fix is applied
platform-wide as the safer, more correct choice, but only retirement's own
scenario was deliberately engineered to test the overflow path).

## Terminal Closure Round Update

`scripts/r10_retirement_certification.mjs` re-run on the final tree,
after this round's three chart-rendering/presentation-layer fixes
(unrelated to the Retirement calculator/eligibility logic this document
covers): **8/8 PASS, unchanged.** No regression. This round's own
visual-certification and manual-reconciliation work additionally
re-confirmed Retirement Readiness rendering correctly in real generated
PDFs (VC09, retirement-heavy scenario) and the retirement account balance
reconciling exactly against the seeded canonical value (MR07, see
`R10_MANUAL_RECONCILIATION.md`).
