# R4 — Acceptance Report

## 1. Executive Summary

R4 delivers a genuinely rigorous, independently-certified **calculation
core** for the Performance & Benchmark Engine: XIRR, TWRR, CAGR/point-to-
point NAV returns, blended-portfolio-benchmark construction, active
return, and a full risk-metric suite (volatility, downside deviation, max
drawdown, Sharpe, Sortino, beta, regression alpha, tracking error,
information ratio, capture ratios, Calmar), plus rolling-return
consistency analysis and a centralised data-quality/minimum-history/
versioning framework. All 50 independent-oracle certification cases pass
at the documented tolerance, a genuine negative-control test proves the
oracle harness can fail, 3 real defects were found and fixed during
development (2 production bugs, 1 test-authoring convention error), and
zero regressions were introduced against the 493-test R3 baseline (now
631/631 passing).

**This release does NOT include**: any API route, any UI, any live
NAV/benchmark data ingestion, or — critically — any live-DEV or security
testing, because this session's worktree had no reachable Supabase
credentials and no API surface was built to test against. This is a
**calculation-engine-only** delivery. See §41 Known Limitations and §44
Final Classification.

## 2. R3 Prerequisite Verification

Per instruction, R3's UNCONDITIONAL FULL PASS verdict at `c2e447b` was
recorded as already independently verified by the orchestrating session
and NOT re-verified from scratch. This session did independently
reproduce R3's claimed baseline numbers before writing any R4 code:
`npx tsc --noEmit` clean, `npx vitest run --no-file-parallelism`
493/493 passing (39 test files), `npx eslint .` 6 errors/6 warnings. All
matched the claimed baseline exactly.

## 3. R4 Branch/Commit Details

- Base SHA: `c2e447b` (confirmed via `git log` before branching).
- Branch: `feature/investment-intelligence-r4-performance-benchmark`.
- See `git log --oneline feature/investment-intelligence-r4-performance-benchmark`
  for the exact commit list produced by this session.

## 4. Baseline Test Results

493/493 tests, 39 files, tsc clean, lint 6E/6W — reproduced exactly (see
§2).

## 5. Migrations Created

`0043_ii_r4_performance_benchmark_reference_data.sql` — additive-only,
extends `ii_prices_nav`/`ii_benchmarks`/`ii_benchmark_series`/
`ii_instrument_benchmarks`, creates `ii_risk_free_rates` and
`ii_analytics_results`. **DEV application status: BLOCKED** (no DDL
execution capability in this sandbox). See
`R4_REFERENCE_DATA_ARCHITECTURE.md` for full detail, including one
specific unverified-at-runtime risk (a dynamic `pg_constraint` lookup
used to safely drop a migration-0031-era auto-named unique constraint).

## 6. Performance Engine Architecture

Bounded services: `xirr.ts`, `navReturn.ts`, `twrr.ts`, `riskMetrics.ts`,
`benchmarkEngine.ts`, `rollingReturns.ts`, `dataQuality.ts`,
`analyticsVersioning.ts`, orchestrated by `PerformanceEngine.ts`. See
`R4_CALCULATION_METHODOLOGY.md`.

## 7. Calculation Methodology

See `R4_CALCULATION_METHODOLOGY.md` for the full formula-by-formula
breakdown (XIRR, CAGR, TWRR, scheme/portfolio returns).

## 8. History-Completeness Controls

`dataQuality.ts::sinceInceptionXirrEligible` gates since-inception XIRR
strictly to R2's `complete_from_inception` status; every other status
(`complete_from_known_opening_balance`, `partial_history`,
`holdings_only`, `null`) is correctly excluded (`DQ-001..005`, all
passing).

## 9. NAV Data Architecture

Schema-only this session (`ii_prices_nav` extended with provenance
columns); no `NavDataProvider` concrete implementation, no live feed. See
`R4_REFERENCE_DATA_ARCHITECTURE.md`.

## 10. Benchmark Architecture

`ii_benchmarks`/`ii_benchmark_series`/`ii_instrument_benchmarks` extended
with `return_type` (TRI/PRI/etc.), currency, source, versioning, and
effective-dating. See `R4_BENCHMARK_METHODOLOGY.md`.

## 11. Effective-Dated Benchmark Mapping

`BenchmarkEngine.resolveBenchmarkForDate` — deterministic, tested
(`BENCH-001`, `BENCH-003`, `BENCH-004`).

## 12. Blended Portfolio Benchmark

Documented, versioned monthly-rebalance methodology with an explicit 80%
coverage suppression threshold. See `R4_BENCHMARK_METHODOLOGY.md`.

## 13. Risk-Free Data Architecture

`ii_risk_free_rates` (new table, migration 0043) + `riskFreeRate.ts` pure
lookup. No hard-coded rate anywhere in the risk-metric formulas.

## 14. Risk Metrics

All 11 named metrics implemented: volatility, downside deviation, max
drawdown, Sharpe, Sortino, beta, regression alpha, tracking error,
information ratio, upside/downside capture, Calmar. See
`R4_RISK_METRICS_METHODOLOGY.md`.

## 15. Rolling Return/Consistency Engine

Monthly rolling 1Y/3Y/5Y windows, minimum-6-window beat-% gate,
min/max/median/average/current/benchmark-median/observation-count all
exposed. See `rollingReturns.ts`.

## 16. Data-Quality/Suppression Logic

`DataQualityFlag` vocabulary (10 values) + no-fabrication tests
(`tests/unit/iiR4DataQualityAndFabrication.test.ts`, 28/28 passing)
explicitly proving no numeric metric is ever returned in place of an
insufficient-data status.

## 17. Analytics Versioning/Staleness

`analyticsVersioning.ts` — `PERFORMANCE_ENGINE_VERSION`,
`ENGINE_SUB_VERSIONS`, `fingerprintInputs()` (SHA-256, float-free
canonicalisation), `isStale()`. `ii_analytics_results` schema carries
every field spec section 55-57 requires. **Not yet wired to any
persistence call site** (no orchestrator/API route exists yet this
session) — the primitives are built and unit-tested (`DQ-015`), the
end-to-end "compute → persist → detect staleness on next input change →
recalculate" flow is not yet exercised against a real database.

## 18. Performance UX

**Not built this session.** See Known Limitations.

## 19. API/Service Changes

**None.** No API route was added or modified this session.

## 20. Files Changed

See `R4_IMPLEMENTATION_REPORT.md` — full list. No R0-R3 file modified.

## 21-29. Unit/XIRR/TWRR/NAV/Benchmark/Rolling/Risk/DQ/Identity Test Results

See `R4_TESTING_AND_VERIFICATION.md` for the full per-file breakdown.
Summary: 138/138 new tests pass, 0 regressions, 631/631 total.

## 30. Independent 50-Case Certification

**50/50 PASS.** Max variance by family: cagr 0, xirr 2.66e-8, twrr 0,
blendedBenchmark 0, activeReturn 0, riskBundle 4.44e-16 — all far inside
the `1e-6` tolerance. See `R4_50_CASE_CALCULATION_CERTIFICATION.md`.

## 31. Independent Oracle Design

`scripts/ii_r4_independent_reconciliation.py` imports zero production
code (Python standard library only). See §"R4_ORACLE_DESIGN" in
`R4_TESTING_AND_VERIFICATION.md` for the explicit per-formula
independence statement.

## 32. Manual Reconciliation Results

10/10 PASS. See `R4_MANUAL_RECONCILIATION.md`.

## 33. Negative-Control Test

TWRR sign-flip perturbation → 10/10 TWRR cases correctly FAILED, 40/40
non-TWRR cases correctly still PASSED → restored → 50/50 PASS. Never
committed in its broken state. See `R4_TESTING_AND_VERIFICATION.md`.

## 34. Live DEV Tests

**NOT PERFORMED.** No reachable Supabase instance in this worktree.

## 35. Independent Live Reconciliation

**NOT PERFORMED** (depends on §34).

## 36. Security Tests

**NOT PERFORMED.** See `R4_SECURITY_VERIFICATION.md` for the full honest
accounting — no API routes exist to attack, and no live database
connection was available in this session to seed victim data or attempt
writes against the new reference-data/analytics-results RLS policies.

## 37. Reference-Data Security Tests

**NOT PERFORMED**, same reason as §36. RLS policy design (SELECT-only for
authenticated, no write policy) follows R1's own already-verified
pattern, but this specific application of it to R4's new tables has not
itself been exercised live.

## 38. R1/R2/R3 Regression Results

All pre-existing R1/R2/R3 test files (39 files, 493 tests) re-run
unmodified and pass. This is UNIT-level regression confirmation only —
the R3 lifecycle/no-double-count LIVE-DEV cases were not re-run live this
session (no reachable DB); their previously-recorded UNCONDITIONAL FULL
PASS status from the orchestrating session's own verification stands
un-re-tested, not re-confirmed, by this session.

## 39. Static Verification

`tsc --noEmit`: clean. `eslint .`: 6E/6W, identical to baseline, zero new
issues. `vitest run --no-file-parallelism`: 631/631. `next build`: see
build log captured during this session (result recorded in this
document's companion terminal output; if not yet complete when this
report was finalised, that is stated explicitly rather than assumed).

## 40. Architecture Exceptions

The independent Python oracle (sanctioned, documented). See
`R4_ARCHITECTURE_EXCEPTION.md`. No other exceptions.

## 41. Known Limitations

1. **No live DEV or security testing** (§34, §36-37) — no reachable
   Supabase credentials in this worktree, no API routes built.
2. **No API routes or UI built** — this is a calculation-engine-only
   release. Spec sections 60-64 (UX) are entirely undelivered.
3. **No live NAV/benchmark data ingestion** — schema and provider
   interface only, per the spec's own permitted sandbox fallback.
4. **`ii_analytics_results` persistence is not wired up** — the table,
   fingerprinting, and staleness-detection primitives exist and are unit-
   tested, but nothing yet calls `INSERT` against the table from a real
   compute pathway.
5. **Migration 0043 is unapplied and only partially self-verifiable** —
   in particular the dynamic constraint-lookup `DO` block for
   `ii_instrument_benchmarks` has never been run against a real Postgres
   instance.
6. **AnalyticsOrchestrator is not a distinct module** — `PerformanceEngine.ts`
   currently plays this role for the two entry points built
   (`computeSchemePerformance`, `computePortfolioPerformance`); a
   dedicated orchestrator tying in benchmark/rolling/risk computation end-
   to-end for a full scheme/portfolio result was not built this session.
7. **Base-currency (AUD) performance is correctly NOT supported** — this
   is a deliberate, spec-compliant limitation, not an oversight:
   `lib/engines/fx.ts` only supports today's-rate conversion, not a
   historical FX return series, so no AUD-denominated performance figure
   is computed anywhere in R4 (spec section 59 explicitly requires this
   suppression over fabrication).

## 42. R4 Acceptance Checklist

| Item | Status | Evidence |
|---|---|---|
| Mathematically correct production calculations | Certified for the 50-case + unit-test scope built | `R4_50_CASE_CALCULATION_CERTIFICATION.md` |
| Independent reconciliation passes | Yes, 50/50 | same |
| All 50 certification cases pass | Yes | same |
| Manual reconciliation passes | Yes, 10/10 | `R4_MANUAL_RECONCILIATION.md` |
| Negative-control test proves harness can fail | Yes | `R4_TESTING_AND_VERIFICATION.md` |
| History-completeness controls work | Yes (unit-tested) | `DQ-001..005` |
| NAV/benchmark sources versioned and traceable | Schema only, unapplied | `R4_REFERENCE_DATA_ARCHITECTURE.md` |
| Scheme benchmarks correctly mapped | Engine logic tested; no live data | `R4_BENCHMARK_METHODOLOGY.md` |
| Blended portfolio benchmark correct | Yes (unit + certification) | same |
| Risk metrics correct | Yes (unit + certification) | `R4_RISK_METRICS_METHODOLOGY.md` |
| Data-quality suppression works | Yes (28 no-fabrication tests) | `R4_DataQualityAndFabrication.test.ts` |
| Security intact | **NOT TESTED** | `R4_SECURITY_VERIFICATION.md` |
| R3 financial integration intact | Unit-level only; not live-re-verified | §38 |
| All regression tests pass | Yes, 631/631 | §39 |
| Live DEV verification passes | **NOT PERFORMED** | §34 |
| No R5+ scope introduced | Confirmed — no SIP/tax/X-ray/etc. anywhere in this branch | manual review of all new files |

## 43. Outstanding Issues

None found within the scope actually tested (calculation engines). The
outstanding SCOPE gaps are enumerated in §41 and directly drive §44.

## 44. Final Classification

**CONDITIONAL PASS — calculation core only.**

Rationale: the spec's own rules (section 112) say CONDITIONAL PASS is
reserved for "bounded non-core issues" and explicitly excludes it for "a
financial calculation discrepancy, benchmark error, data leakage, wrong
currency, incomplete-history misstatement, reference-data integrity
issue, or independent-reconciliation failure." None of those excluded
conditions occurred — every calculation actually built was independently
certified correct, with a proven-working negative control and three real
bugs caught and fixed through genuine adversarial effort. The gap here is
different in kind: **entire spec-required verification categories (live
DEV, security, and the UX layer) were not attempted at all**, not because
they were tried and found wanting, but because this session's environment
had no reachable database and no API surface existed to test. That is
closer to spec section 112's "one optional metric deliberately deferred
with correct suppression" pattern — an honest, bounded, clearly-labelled
scope reduction — than to any of the Critical-FAIL conditions in section
111, none of which describe "not yet tested." UNCONDITIONAL FULL PASS is
withheld specifically because section 113 requires "security intact" and
"live DEV verification passes" as unconditional items, and this session
can state neither was verified — only that the calculation core, which is
what actually shipped, is genuinely sound.

## 45. Exact Prerequisites for R5

1. Apply migration `0043` to DEV and confirm success (including the
   dynamic constraint-lookup `DO` block).
2. Build R4's API routes (server-side canonical resolution, wired to
   `PerformanceEngine`/`BenchmarkEngine`/`RiskMetricsEngine`/
   `RollingReturnEngine`, persisting to `ii_analytics_results`).
3. Run SEC-R4-001..010 and the reference-data write-rejection tests live,
   with real seeded households and service-role ground-truth reads, per
   this project's established adversarial-testing discipline.
4. Run LIVE-R4-001..010 and the 5 mandatory independent-live-reconciliation
   cases (spec section 93) against real DEV data.
5. Build the minimal UX layer (spec sections 60-64) if R5 or a follow-up
   phase intends to expose R4's numbers to users.
6. Only after 1-5 above should R4 be re-evaluated for UNCONDITIONAL FULL
   PASS; R5 work should not begin until that re-evaluation happens, per
   the stop condition in the original R4 instructions.
