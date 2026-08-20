# R4 — Testing and Verification

This document distinguishes STATIC / UNIT / LOCAL-DB / LIVE-DEV / MANUAL /
INDEPENDENT-ORACLE explicitly, per this project's established discipline.

**Status after the continuation pass (2026-08-20).** The original R4 pass
delivered the calculation core only and could perform no LIVE-DEV or
SECURITY testing. The continuation pass added the service/API/UX layers
and *did* run live-DEV and security testing against DEV
`vqycarelcoijzwlpkpcz`. Live results are in §LIVE-DEV below and in
`R4_SECURITY_VERIFICATION.md`. A subset remains genuinely BLOCKED because
migration 0043 sections 4-5 are still unapplied — recorded as blocked, not
as passes.

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

`npx vitest run --no-file-parallelism`: **669/669 tests pass**, 49 files,
plus 5 opt-in live-DEV tests that skip unless `II_R4_LIVE=1` (50 files
total). 0 regressions.

Progression across the two passes:

| Point | Tests | Files |
| --- | --- | --- |
| R3 baseline (`c2e447b`) | 493 | 39 |
| R4 calculation core (`27bd370`) | 631 | 48 |
| R4 continuation (this pass) | **669** | **50** |

The continuation pass added exactly one file (`iiR4ServiceLayer.test.ts`,
32 cases) and changed no existing test. The 631-test figure was
independently reproduced at the start of this pass before any code was
written, along with `tsc` clean and lint 6E/6W — all three matched the
prior pass's claims exactly.

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

## LIVE-DEV (continuation pass, 2026-08-20)

Harness: `scripts/ii_r4_live_dev_security_tests.mjs`, run against DEV
`vqycarelcoijzwlpkpcz`. Seeds throwaway instruments, benchmarks,
transactions, snapshots and NAV series under two ephemeral
`@fhip-test.local` users, then deletes everything in teardown.
**PASS 37 · FAIL 0 · BLOCKED 0 (37 checks)** after the corrected migration 0043 was applied on 2026-08-20. The pre-migration run of the same unmodified harness returned PASS 26 / FAIL 4 / BLOCKED 7.

### Seeded scenarios (spec section 91)

| ID | Scenario | Result |
| --- | --- | --- |
| LIVE-R4-001 | Lump-sum single purchase | PASS |
| LIVE-R4-002 | Irregular-date multi-purchase (2021-02-17 / 2021-07-03 / 2022-03-22) | PASS |
| LIVE-R4-003 | Purchase + partial redemption | PASS |
| LIVE-R4-004 | Multi-scheme portfolio (7 schemes, 2 currencies) | PASS |
| LIVE-R4-005 | XIRR-vs-TWRR divergent (irregular contribution timing) | PASS |
| LIVE-R4-006 | Benchmark underperformer (fund 0.4%/mo vs benchmark 2.0%/mo) | PASS |
| LIVE-R4-007 | Benchmark outperformer (fund 2.0%/mo vs benchmark 0.3%/mo) | PASS |
| LIVE-R4-008 | Partial-history position | PASS |
| LIVE-R4-009 | Scheme with no benchmark mapping | PASS |
| LIVE-R4-010 | AUD holding alongside INR holdings | PASS |

### Independent live reconciliation (spec section 93 — minimum 5 required)

Ground truth is pulled **directly from the database** and recomputed by an
independent implementation embedded in the harness — pure bisection XIRR
and an independently-written chain-linked TWRR, neither importing any
production code. This is not production re-run through a second API path.

| ID | Instrument | Independent XIRR | Relative NPV residual |
| --- | --- | --- | --- |
| RECON-LIVE-001 | lump sum | 13.280789% | 0.000e+0 |
| RECON-LIVE-002 | irregular multi-purchase | 10.274092% | 0.000e+0 |
| RECON-LIVE-003 | purchase + redemption | 9.076975% | 8.460e-17 |
| RECON-LIVE-004 | underperformer | 5.122736% | 1.386e-16 |
| RECON-LIVE-005 | outperformer | 28.324292% | 5.571e-17 |
| RECON-LIVE-006 | AUD fund | 7.814884% | 1.688e-16 |
| RECON-LIVE-007 | TWRR, purchase + redemption case | -22.500000% | n/a |

Seven cases against a required minimum of five. Each XIRR is verified by
the defining property — that it zeroes the NPV of the DB-sourced cash-flow
series — to a relative residual at or below 1.7e-16, i.e. floating-point
exact.

### Previously blocked, now resolved

Before migration 0043 sections 4-5 were applied, everything depending on
`ii_risk_free_rates` and on the R4 shape of `ii_analytics_results` was
recorded BLOCKED rather than fabricated. All of it now evaluates for real
and passes.

### Live end-to-end integration (opt-in)

`tests/unit/iiR4LiveIntegration.test.ts`, run with `II_R4_LIVE=1`, exercises
the real production path end to end against a seeded 36-month portfolio:
`loadAnalyticsDataset -> runAnalytics -> toPersistableRows ->
persistAnalyticsRows`. **5/5 pass.** It covers what the REST harness
structurally cannot: the upsert's `onConflict` list against the table's
real unique index (LIVE-INT-003 persists, then re-runs and asserts the row
count is unchanged), and that Sharpe/Sortino/alpha genuinely compute
against seeded reference data (LIVE-INT-002).

### BROWSER

The Performance page was rendered against a seeded four-fund,
two-currency portfolio. **This found two real defects that tsc, 663 unit
tests, a clean production build and the entire live/security harness had
all passed over** — a fabricated all-zero benchmark driving tracking
error, information ratio and rolling beat-%, and an as-of date that
flat-extrapolated stale data. See `R4_IMPLEMENTATION_REPORT.md` defects 5
and 6, and `R4_API_AND_UX_ARCHITECTURE.md` §10.

The lesson worth carrying forward: unit tests covered "no benchmark at
all" but not "a benchmark that exists but falls below the coverage
threshold". Render a mixed fixture after any change to suppression logic.

Full detail, including the live security gap this surfaced and the
migration fix written in response, is in `R4_SECURITY_VERIFICATION.md` §3.

## SECURITY

See `R4_SECURITY_VERIFICATION.md` — 26 PASS / 4 FAIL / 7 BLOCKED, all
failures and blocks tracing to the same unapplied migration sections.
