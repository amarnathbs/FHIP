# R4 — Benchmark Methodology

## Effective-dated benchmark mapping

`ii_instrument_benchmarks` (migration `0031`, extended by `0043`) now
carries `effective_from` / `effective_to` / `source_id` / `mapping_version`
/ `quality_status`. `BenchmarkEngine.resolveBenchmarkForDate(mappings,
instrumentId, date)` returns the mapping whose effective range covers the
queried date — deterministic, never hard-coded in a UI component
(`BENCH-001`, `BENCH-003`, `BENCH-004`).

For an analysis period spanning a benchmark change, the engine's
period-level design (blended benchmark computed per rebalance period, each
period independently resolving its own applicable benchmark) means the
correct old/new benchmark is automatically used for the sub-periods before
and after the change — no separate "spanning" logic is needed because the
resolution already happens at the period-return level, not once for the
whole horizon. This is the documented treatment (spec section 31): each
period gets its own correctly-dated resolution rather than a single
before/after split calculated separately.

## TRI vs PRI

`ii_benchmarks.return_type` (migration `0043`) records `TRI` / `PRI` /
`DEBT_INDEX` / `COMMODITY_GOLD` / `OTHER`. R4 does not ingest any live
benchmark series in this sandbox (no production NAV/benchmark feed is
approved or available here — see `R4_REFERENCE_DATA_ARCHITECTURE.md`), so
no case in this release actually silently substitutes a PRI series for a
stated TRI benchmark; the schema and the `BenchmarkMapping.returnType`
field exist so that whichever release next populates real benchmark data
is structurally prevented from doing so undetected (`BENCH-002`).

## Blended portfolio benchmark

Documented, versioned methodology
(`BLENDED_BENCHMARK_METHOD_VERSION = 'blended-benchmark-monthly-rebalance-v1'`):

1. Resolve each holding's primary benchmark via the effective-dated mapping.
2. Portfolio weights at the START of each rebalance period.
3. Aggregate holdings sharing a benchmark.
4. `R_blend,t = Σ w_i,t-1 × R_benchmark_i,t`, renormalised by the
   *covered* weight (so an unmapped holding's absence doesn't silently
   drag the blended return toward zero — its effect is instead visible
   entirely through the separately-reported coverage %).
5. Rebalance monthly (`REBALANCE_FREQUENCY = 'monthly'`, versioned;
   changing it requires bumping `BLENDED_BENCHMARK_METHOD_VERSION`).
6. Chain-link `Π(1 + R_blend,t) − 1`.

## Coverage and suppression

`MIN_COVERAGE_FOR_CONCLUSION = 0.80`. Below 80% value-weighted average
benchmark-mapping coverage across the periods in scope, `blendedBenchmarkReturn`
returns `status: 'unavailable'`, `reason: 'INSUFFICIENT_BENCHMARK_COVERAGE'`
— the caller must suppress or explicitly qualify the active-return
conclusion (`BENCH-006`, `BENCH-010`, `DQ-006`). The blended return and
coverage percentage are still both returned even in the unavailable case
so the caller CAN choose to show "Benchmark coverage: 62%" with the
conclusion qualified rather than a bare error, per spec section 34's
explicit language — the choice of exactly how to render that in the UI is
deferred (see Known Limitations; no UI was built this session).

## Active return — compatible metrics only

`activeReturn(portfolioMetric, benchmarkMetric, metricFamily)` requires an
explicit `metricFamily: 'TWRR' | 'CAGR' | 'POINT_TO_POINT'` argument —
there is no overload that omits it, so a caller cannot accidentally
subtract an XIRR from a TWRR and label the result "active return."
`BENCH-006` demonstrates the correct compatible case (CAGR − CAGR);
Identity D (`tests/unit/iiR4MathIdentities.test.ts`) demonstrates that
identical portfolio/benchmark periodic returns produce exactly `0` active
return, with no rounding drift.

## Test pack coverage

`tests/unit/iiR4Benchmark.test.ts` (BENCH-001..015, 16/16 passing) and
`tests/unit/iiR4Certification50Case.test.ts` (TC031-035 blended-benchmark
cases, TC036-040 active-return cases, all 10 passing against the
independent oracle at `≤1e-6`).
