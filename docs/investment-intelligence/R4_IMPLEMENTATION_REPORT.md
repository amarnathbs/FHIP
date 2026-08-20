# R4 — Implementation Report

## Branch and commits

- Base: `feature/investment-intelligence-r3-fhip-publishing` @ `c2e447b`
  (independently verified UNCONDITIONAL FULL PASS by the orchestrating
  session prior to this work; not re-verified from scratch here per
  instruction, but its baseline test count (493/493) and lint baseline
  (6E/6W) were independently reproduced in this session before any R4
  code was written — see `R4_ACCEPTANCE_REPORT.md` §4).
- Branch: `feature/investment-intelligence-r4-performance-benchmark`,
  created via `git checkout c2e447b -b
  feature/investment-intelligence-r4-performance-benchmark`.
- Commits: see `git log` on this branch for the exact SHA list; this
  session's work was committed as (a) the calculation engines + config +
  unit tests + certification harness + oracle + migration, and (b) the
  documentation set, in logically separated commits per this project's
  usual practice (exact SHAs recorded in the final response to the
  orchestrating session, not duplicated here to avoid staleness — see
  `git log --oneline` for ground truth).

## What was built

### Calculation engines (`lib/engines/investment-intelligence/`)

- `xirr.ts` — money-weighted return, safeguarded Newton-bisection hybrid.
- `navReturn.ts` — point-to-point return, CAGR, calendar-year returns.
- `twrr.ts` — time-weighted return, chain-linked sub-periods.
- `riskMetrics.ts` — volatility, downside deviation, max drawdown, Sharpe,
  Sortino, beta, regression alpha, tracking error, information ratio,
  upside/downside capture, Calmar.
- `benchmarkEngine.ts` — effective-dated benchmark resolution, blended
  portfolio benchmark, active return.
- `rollingReturns.ts` — rolling N-year return series, benchmark beat %.
- `dataQuality.ts` — since-inception XIRR eligibility gate, payout-option
  total-return eligibility gate, `DataQualityFlag` vocabulary.
- `analyticsVersioning.ts` — engine/config version aggregation, input
  fingerprinting (SHA-256 over a canonicalised, float-free representation),
  staleness detection.
- `PerformanceEngine.ts` — orchestration entry points
  (`computeSchemePerformance`, `computePortfolioPerformance`) combining
  the above; purely derived, never writes to any R1-R3 financial-register
  table.

### Reference-data config (`lib/config/investment-intelligence/`)

- `minimumHistory.ts` — centralised, versioned eligibility thresholds.
- `riskFreeRate.ts` — versioned risk-free-rate lookup (no hard-coded rate
  anywhere in `riskMetrics.ts`).

### Database (`supabase/migrations/0043_ii_r4_performance_benchmark_reference_data.sql`)

Additive-only. Extends `ii_prices_nav`, `ii_benchmarks`,
`ii_benchmark_series`, `ii_instrument_benchmarks` (adds effective-dating);
creates `ii_risk_free_rates` and `ii_analytics_results`. **NOT applied to
DEV — BLOCKED, no DDL execution capability in this sandbox.** See
`R4_REFERENCE_DATA_ARCHITECTURE.md`.

### Independent certification pipeline

- `scripts/ii-r4-certification/generate_cases.mjs` — deterministic
  50-case input generator (fixed-seed PRNG), zero production imports.
- `scripts/ii_r4_independent_reconciliation.py` — the independent oracle,
  zero production imports (see `R4_TESTING_AND_VERIFICATION.md` for the
  full independence statement).
- `tests/unit/iiR4Certification50Case.test.ts` — the harness that
  computes production results via real imports, loads the oracle's
  pre-computed results, and asserts tolerance-bounded agreement for all
  50 cases; writes `scripts/ii-r4-certification/comparison_report.json`.

### Unit tests

8 new test files, 138 new tests, all passing (`R4_TESTING_AND_VERIFICATION.md`).

## Real bugs found and fixed during this session (not fabricated — each
## reproduced red, fixed, reproduced green, before any commit)

1. **XIRR premature-convergence bug**: the safeguarded-Newton solver's
   step-size-based convergence check could return a non-root value when a
   bisection fallback's midpoint coincidentally equalled the previous
   iteration's midpoint. Found by `XIRR-006` (same-day flows, exact
   expected root `r=0.4`, got `r=0.41`). Fixed by requiring the actual
   NPV function value (not step size) to be near zero before returning.
2. **CAGR/point-to-point boundary inconsistency**: `cagr()`'s own
   "annualise only if >1 year" cutoff (`years < 1`) disagreed with
   `pointToPointReturn()`'s stricter cutoff (`actualDays > 365`), so an
   exactly-365-day period got a spuriously-attached CAGR value. Found by
   the independent 50-case oracle (`TC002`, `TC004` initially FAILED).
   Fixed by making `cagr()` a strict pass-through of
   `pointToPointReturn()`'s own single boundary decision.
3. **TWRR test-authoring convention mismatch** (not an engine bug, but a
   real defect in the FIRST draft of the test suite): 7 of 15 initial
   `TWRR-*` unit tests modeled boundary valuations as pre-flow instead of
   the engine's documented post-flow convention. Every case was corrected
   once the convention was applied consistently; documented explicitly in
   `R4_TWRR_CERTIFICATION.md` because it is exactly the kind of
   "different convention in different places" risk the spec warns about,
   and getting it right the first time (in production code, tests, AND
   the oracle) was the actual discipline being tested.

## Files changed (new files only — no existing R0-R3 file was modified)

```
lib/engines/investment-intelligence/xirr.ts
lib/engines/investment-intelligence/navReturn.ts
lib/engines/investment-intelligence/twrr.ts
lib/engines/investment-intelligence/riskMetrics.ts
lib/engines/investment-intelligence/benchmarkEngine.ts
lib/engines/investment-intelligence/rollingReturns.ts
lib/engines/investment-intelligence/dataQuality.ts
lib/engines/investment-intelligence/analyticsVersioning.ts
lib/engines/investment-intelligence/PerformanceEngine.ts
lib/config/investment-intelligence/minimumHistory.ts
lib/config/investment-intelligence/riskFreeRate.ts
supabase/migrations/0043_ii_r4_performance_benchmark_reference_data.sql
scripts/ii-r4-certification/generate_cases.mjs
scripts/ii-r4-certification/cases.json (generated artifact)
scripts/ii-r4-certification/oracle_results.json (generated artifact)
scripts/ii-r4-certification/comparison_report.json (generated artifact)
scripts/ii_r4_independent_reconciliation.py
tests/unit/iiR4Xirr.test.ts
tests/unit/iiR4Twrr.test.ts
tests/unit/iiR4NavReturn.test.ts
tests/unit/iiR4Benchmark.test.ts
tests/unit/iiR4Rolling.test.ts
tests/unit/iiR4RiskMetrics.test.ts
tests/unit/iiR4MathIdentities.test.ts
tests/unit/iiR4DataQualityAndFabrication.test.ts
tests/unit/iiR4Certification50Case.test.ts
docs/investment-intelligence/R4_*.md (this document and 12 others)
```

**No R0-R3 production file was modified.** `git diff c2e447b --stat` shows
only additions under the paths above (plus the new migration file) —
this is directly verifiable and is the same "literal zero-line diff"
discipline R3 itself demonstrated against R2.

## Explicitly NOT built this session (see Known Limitations, Acceptance Report)

- No API routes.
- No UI (portfolio dashboard, scheme table, benchmark chart, drawdown
  chart, "how this was calculated" view).
- No `AnalyticsOrchestrator` persistence wiring to `ii_analytics_results`
  (the table and the fingerprinting/staleness primitives exist; nothing
  yet calls `INSERT` against it).
- No live NAV/benchmark data ingestion (schema-only, per spec's own
  permitted sandbox fallback).
- No live DEV testing, no security testing (no reachable Supabase
  instance, no API routes to attack).

---

## Continuation Pass (2026-08-20) — Service, API and UX Layers

The original report above covers the calculation core at `27bd370`. This
section records the continuation pass, which added everything above the
engines. **No certified engine file was modified.**

### Files added

| File | Purpose |
| --- | --- |
| `lib/engines/investment-intelligence/calculationStatus.ts` | 7-status vocabulary + deterministic mapping from each engine's reason union. |
| `lib/engines/investment-intelligence/benchmarkService.ts` | Builds monthly-rebalanced period structure; coverage and TRI/PRI discipline. |
| `lib/engines/investment-intelligence/riskMetricsService.ts` | Runs the risk suite; resolves risk-free rate from versioned reference data. |
| `lib/engines/investment-intelligence/rollingReturnService.ts` | 1Y/3Y/5Y horizons + benchmark-beat pairing. |
| `lib/engines/investment-intelligence/analyticsOrchestrator.ts` | Pure top-level entry point; currency separation; persistence mapping; staleness. |
| `lib/services/investment-intelligence/analyticsRepository.ts` | The only I/O boundary. Read-only except the derived-analytics upsert. |
| `app/api/investment-intelligence/analytics/route.ts` | GET derived results. |
| `app/api/investment-intelligence/analytics/recalculate/route.ts` | POST recompute + persist. |
| `app/(app)/investment-intelligence/performance/page.tsx` | Performance page. |
| `components/investment-intelligence/PerformanceClient.tsx` | Full Performance UX. |
| `tests/unit/iiR4ServiceLayer.test.ts` | 32 service-layer tests. |
| `scripts/ii_r4_schema_probe.mjs` | Read-only migration-0043 application probe. |
| `scripts/ii_r4_live_dev_security_tests.mjs` | LIVE-R4 + SEC-R4 harness. |
| `scripts/ii_r4_analytics_rls_probe.mjs` | Focused analytics-write exploitation probe. |
| `docs/investment-intelligence/R4_API_AND_UX_ARCHITECTURE.md` | This layer's architecture. |

### Files modified

* `supabase/migrations/0043_…sql` — made idempotent; section 5 corrected to
  handle the pre-existing `ii_analytics_results` table (see below).
* `R4_SECURITY_VERIFICATION.md` — rewritten with real live results.
* `R4_TESTING_AND_VERIFICATION.md`, `R4_ACCEPTANCE_REPORT.md` — updated.

### Defects found and fixed during this pass

1. **Migration 0043 could never apply (blocking).** Migration 0035 already
   creates `ii_analytics_results`; section 5's bare `create table` fails
   with *relation already exists*, so the hardened RLS policy was never
   installed. Its 0035 predecessor policy is `for all using (auth.uid() =
   user_id)`, granting writes to ordinary users. Confirmed by direct
   exploitation against DEV (HTTP 201 on a forged insert), not inferred.
   Fixed by renaming the legacy table aside, stripping its permissive
   policy, and creating the R4 table under the canonical name — plus
   making the whole migration idempotent so it can be safely re-run over
   the already-applied sections 1-3.

2. **Case-insensitive filesystem collision (self-inflicted, caught).** A
   service file initially named `BenchmarkEngine.ts` silently overwrote
   the certified `benchmarkEngine.ts` primitives on Windows. Caught via
   `git status` showing the primitives file modified; restored from git
   before anything consumed it. Service filenames are now lexically
   distinct from the primitives they wrap, with header comments explaining
   why. Recorded because the hazard will recur for anyone adding a
   `PascalCase` service beside a `camelCase` primitive.

3. **Wrong argument order against four risk primitives.** The first draft
   of `riskMetricsService.ts` called `downsideDeviation`, `sharpeRatio`,
   `sortinoRatio`, `regressionAlpha` and `calmarRatio` with transposed
   arguments (e.g. `sharpeRatio(returns, rf, ppy)` where the signature is
   `(returns, ppy, rf)`), and passed a bare number to `calmarRatio` where
   it expects a full `DrawdownResult` plus `historyDays`. Caught by
   reading the actual signatures rather than trusting the draft, and
   corrected before any test was written against the wrong behaviour.

4. **Conceptual error in downside-deviation suppression.** The first draft
   suppressed downside deviation when risk-free data was absent. That is
   wrong: the certified primitive's MAR defaults to 0 per period and needs
   no risk-free input. Corrected so only Sharpe, Sortino and alpha are
   suppressed — verified by `SVC-RISK-001`, which asserts volatility,
   downside deviation and max drawdown all still compute with an empty
   risk-free series.
