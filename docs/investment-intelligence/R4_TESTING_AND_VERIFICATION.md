# R4 — Testing and Verification

This document distinguishes STATIC / UNIT / LOCAL-DB / LIVE-DEV / MANUAL /
INDEPENDENT-ORACLE explicitly, per this project's established discipline.
**LIVE-DEV, LOCAL-DB, and adversarial SECURITY testing were NOT performed
this session** (no reachable Supabase instance, no DDL capability, no API
routes built) — see `R4_SECURITY_VERIFICATION.md` and
`R4_ACCEPTANCE_REPORT.md` for the honest accounting of that gap.

## STATIC

- `npx tsc --noEmit`: clean, 0 errors (baseline: clean, 0 errors — R3 tip
  `c2e447b` and every commit in this branch).
- `npx eslint .`: 6 errors / 6 warnings, **identical to the pre-existing
  R3 baseline** — all 6 errors/6 warnings are in files R4 never touched
  (`AdminBenchmarksClient.tsx`, `AdminRecommendationsClient.tsx`,
  `FinancialDataGrid.tsx`, `RecommendationsPanel.tsx`, `AppShell.tsx`,
  `goals/page.tsx`). Zero new lint issues introduced by R4 code (verified
  by first getting a real 1-warning regression during development —
  an unused loop variable in a test fixture — and fixing it before this
  final count).
- `npx next build` (Turbopack): succeeds, exit code 0, once real Supabase
  credentials are present in the worktree (the build's static-prerender
  step needs them for two pre-existing pages, `/admin/benchmarks` and
  `/signup`, unrelated to any R4 code). See `R4_ACCEPTANCE_REPORT.md` §39.

## UNIT

`npx vitest run --no-file-parallelism`: **631/631 tests pass** (baseline
493 + 138 new R4 tests), 48 test files, 0 regressions in any pre-existing
test (including R1/R2/R3 security/parser/reconciliation/publication/
lifecycle tests — all re-run unmodified and still green).

New R4 test files:

| File | Cases | Result |
|---|---|---|
| `tests/unit/iiR4Xirr.test.ts` | XIRR-001..020 + 2 domain-guard tests | 22/22 |
| `tests/unit/iiR4Twrr.test.ts` | TWRR-001..015 | 15/15 |
| `tests/unit/iiR4NavReturn.test.ts` | NAV-001..018 | 14/14 (some NAV cases combined/documented-boundary) |
| `tests/unit/iiR4Benchmark.test.ts` | BENCH-001..015 | 16/16 |
| `tests/unit/iiR4Rolling.test.ts` | ROLL-001..010 + sample-size test | 11/11 |
| `tests/unit/iiR4RiskMetrics.test.ts` | RISK-001..020 | 26/26 |
| `tests/unit/iiR4MathIdentities.test.ts` | Identities A-D | 4/4 |
| `tests/unit/iiR4DataQualityAndFabrication.test.ts` | DQ-001..015 + no-fabrication tests | 28/28 |
| `tests/unit/iiR4Certification50Case.test.ts` | 50-case oracle cross-check | 2/2 (loads 50 cases, all 50 individually PASS within the test) |

## INDEPENDENT ORACLE

See `R4_50_CASE_CALCULATION_CERTIFICATION.md` for the full 50/50 result
and `R4_ORACLE_DESIGN` (below) for the independence statement, and the
negative-control test (also below) proving the harness genuinely can
fail.

## MANUAL

See `R4_MANUAL_RECONCILIATION.md` — 10/10 hand-worked cases (2 XIRR, 2
TWRR, 2 benchmark, 1 rolling, 1 drawdown, 1 beta, 1 blended-portfolio),
all exact or within `<0.00001` of the production result (variance
entirely attributable to the hand-calculation's own limited number of
carried significant figures, not to any engine discrepancy).

## Negative-control test (spec section 80)

**What was changed**: `lib/engines/investment-intelligence/twrr.ts`,
line computing `adjustedEndValue`, temporarily changed from
`endValuation.value - flowTotalAtEnd` to
`endValuation.value + flowTotalAtEnd` (sign flip on the cash-flow
adjustment).

**Expected**: the 50-case certification harness should fail on every TWRR
case, since production would now disagree with the independent oracle
(which was never touched).

**Observed (RED)**: `npx vitest run tests/unit/iiR4Certification50Case.test.ts`
failed with exactly the 10 TWRR cases (`TC021`-`TC030`) reporting
`FAIL`, with material variances (e.g. `TC030`: production `-0.0773`
vs oracle `0.1238`, variance `0.201`) — all 40 non-TWRR cases still
passed, confirming the harness's failure detection is scoped correctly
to the actually-broken code path, not a blanket false-positive.

**Restoration**: the sign was reverted to `endValuation.value -
flowTotalAtEnd`.

**Subsequent (GREEN)**: `npx vitest run tests/unit/iiR4Certification50Case.test.ts
tests/unit/iiR4Twrr.test.ts` — 17/17 tests pass, all 50 certification
cases PASS.

This perturbation was never committed — it was made, confirmed red, and
reverted within the same development session before any commit touching
`twrr.ts` was made.

## `R4_ORACLE_DESIGN` — independence statement

`scripts/ii_r4_independent_reconciliation.py` imports:
`json`, `sys`, `statistics`, `decimal`, `datetime` — all Python standard
library. It imports **nothing** from `lib/engines/investment-intelligence/`
or any other production TypeScript. It reimplements, from the published
mathematical formulas (not by reading production source), independent
versions of: XIRR (pure bisection, no Newton/derivative step anywhere —
see `R4_XIRR_CERTIFICATION.md`), point-to-point return/CAGR
(actual/365, independently re-derived), TWRR (independently re-identifies
sub-period boundaries and chain-links from scratch, never consuming
production's own `subPeriods` output), blended benchmark (independently
aggregates weighted period returns and chain-links), and a risk-metric
bundle (volatility/beta/tracking-error/Sharpe/max-drawdown from the
`statistics` module's sample stdev, not any shared helper). The input
data both implementations consume (`scripts/ii-r4-certification/cases.json`)
is generated by a separate, also-production-code-free JS script
(`generate_cases.mjs`).

## What was NOT done (see `R4_SECURITY_VERIFICATION.md` / `R4_ACCEPTANCE_REPORT.md`)

LOCAL-DB and LIVE-DEV testing (LIVE-R4-001..010), the 5 mandatory
independent-live-reconciliation cases (spec section 93), and all
SEC-R4/SEC-R4-REFDATA security tests were not executed — no reachable
Supabase instance in this worktree and no API routes were built this
session. This is reported honestly rather than fabricated; see the Final
Classification in `R4_ACCEPTANCE_REPORT.md`.
