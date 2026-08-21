# R5 — Independent Certification

## 1. Structure

The R5 certification pack contains **89 cases** across the eight mandated
families, which subsumes and exceeds the 60-case framework required by spec
sections 82–89.

| Family | Cases | IDs |
| --- | --- | --- |
| SIP detection + actual XIRR | 20 | SIP-001 … SIP-020 |
| Identical-cash-flow benchmark SIP | 10 | SIP-BENCH-001 … 010 |
| Historical flat / step-up simulation | 8 | STEP-001 … 008 |
| Weighted look-through | 15 | XRAY-001 … 015 |
| Fund overlap | 10 | OVERLAP-001 … 010 |
| Concentration + classification | 8 | CONC-001 … 008 |
| Debt X-Ray | 8 | DEBT-001 … 008 |
| Data quality / no-fabrication | 10 | DQ-R5-001 … 010 |
| **Total** | **89** | |

## 2. Independence

`scripts/ii-r5-certification/generate_cases.mjs`
: Fixed-seed, dependency-free, deterministic. **Imports nothing from
  production.** Writes `cases.json`, the single shared input both sides
  consume. Regenerating it produces a byte-identical file — verified by
  `git diff --ignore-cr-at-eol` reporting no content change.

`scripts/ii_r5_independent_reconciliation.py`
: The oracle. **Imports no production code** — not `sipDetection`,
  `sipAttribution`, `sipXirr`, `sipConsistency`, `sipSimulation`,
  `dateAlignment`, `securityResolution`, `lookThrough`, `overlap`,
  `concentration`, `debtXray`, `xirr.ts`, or any config module. It does not
  subprocess, transpile, or otherwise execute them. Its only inputs are
  `cases.json` and its own transcription of the documented methodology.

: **Crucially, its XIRR is a different algorithm.** Production uses safeguarded
  Newton-Raphson bracketed by bisection; the oracle uses pure high-precision
  bisection with no derivative step. A Newton-specific production bug could not
  be reproduced by the oracle. This is why non-zero XIRR variances appear at
  the 1e-9 level — they are genuine convergence differences between two
  independent solvers, not shared logic.

: Expected values are **never** generated using production code.

`tests/unit/iiR5Certification.test.ts`
: The production side. Consumes the identical `cases.json`, runs it through the
  real engines, and compares against `oracle_results.json`.

## 3. Pre-declared tolerances

Declared in code before any result was reviewed, and **never widened after a
failure** — a failure is fixed in the engine, not absorbed by the tolerance.

| Quantity | Tolerance |
| --- | --- |
| XIRR / rate | 1e-6 |
| Weight calculations | 1e-8 |
| Overlap | 1e-8 |
| Sector / market-cap exposure | 1e-8 |
| HHI | 1e-8 |
| Simulation currency value | 0.01 (₹0.01, the smallest material unit) |

## 4. Results

**89 / 89 cases pass. 698 individual metric comparisons, 698 PASS, 0 FAIL.**

Of those 698 comparisons, 489 compare two real non-null numeric values (the
remainder are exact status/label/ordering comparisons, and 14 are legitimate
both-null "unavailable" agreements).

| Family | Comparisons | Max variance | Failures |
| --- | --- | --- | --- |
| SIP | 118 | 3.108e-08 | 0 |
| Benchmark SIP | 40 | 5.749e-08 | 0 |
| Simulation | 48 | 1.904e-08 | 0 |
| X-Ray look-through | 213 | **0** | 0 |
| Overlap | 87 | **0** | 0 |
| Concentration | 33 | 3.331e-16 | 0 |
| AMC concentration | 6 | **0** | 0 |
| Debt | 123 | **0** | 0 |
| Data quality | 30 | **0** | 0 |

The largest variance anywhere is **5.749e-08** in a benchmark-SIP XIRR, against
a 1e-6 tolerance — a factor of 17 inside the limit, and attributable to the two
solvers' differing convergence paths.

Every X-Ray, overlap, debt and data-quality comparison agreed **exactly**.
Concentration's 3.3e-16 residual is IEEE-754 summation noise.

## 5. Mandatory identity tests

| Test | Result |
| --- | --- |
| Weighted look-through: A 60% × X 10% + B 40% × X 20% = exactly 14% | PASS (variance 0) |
| Spec worked example: 3.2% + 2.0% = 5.2% effective Reliance exposure | PASS (variance 0) |
| Overlap symmetry `Overlap(A,B) === Overlap(B,A)` | PASS (bit-identical) |
| Overlap bounds `0 ≤ overlap ≤ 1` across six degenerate fixtures | PASS |
| Identical portfolios → exactly 100% | PASS |
| Disjoint portfolios → exactly 0% | PASS |
| Overlap worked example: min(5%, 8%) = exactly 5% | PASS |
| Unresolved holdings never matched, even with identical names | PASS |
| Full matrix symmetric, bounded, diagonal 1 | PASS |
| HHI: one security at 100% → exactly 1.0 | PASS |
| HHI: ten equal securities → exactly 0.1 | PASS |
| No-double-count: all weight buckets sum to exactly 1 | PASS (1e-8) |
| Effective values sum back to the portfolio value | PASS (1e-6) |
| No look-ahead: a future snapshot is never selected | PASS |
| 87% disclosure stays 87%, not rescaled | PASS |
| Cash weight preserved, not redistributed | PASS |

## 6. No-fabrication proofs

| Situation | Required behaviour | Result |
| --- | --- | --- |
| No holdings at all | No fake 0% sector chart | PASS — status unavailable, 0 buckets |
| Missing benchmark | No fake benchmark SIP result | PASS — `MISSING_BENCHMARK`, rate undefined |
| Benchmark missing one contribution date | Whole comparison suppressed | PASS — `INCOMPLETE_BENCHMARK_HISTORY` |
| Ambiguous purchases | Never `CONFIRMED_SOURCE` | PASS — `AMBIGUOUS` |
| Two purchases only | Never an inferred SIP | PASS |
| Units missing anywhere | No fabricated SIP-specific XIRR | PASS — `ATTRIBUTION_UNAVAILABLE` |
| NAV missing | No assumed/last-known ending value | PASS — `NAV_UNAVAILABLE` |
| Missing credit ratings | Not converted into a rating | PASS — `UNRATED` bucket, labelled as data availability |
| Conflicting multi-agency ratings | Consolidation suppressed, agency data retained | PASS |
| Missing duration | Never estimated from maturity | PASS — unavailable |
| Partial duration coverage (30%) | Suppressed, not extrapolated | PASS |
| Stale holdings | Visible warning, never "current" | PASS — `STALE_HOLDINGS` |
| Excess return with either leg missing | Not actual-minus-zero | PASS |
| Label check | Never "alpha" | PASS |

"Unavailable" is never "zero" anywhere in the pack.

## 7. Negative controls — both genuinely executed

Both were run as real green → red → green cycles. Neither defect is committed;
both files were verified byte-identical to their committed state afterwards via
`git diff --numstat` (zero changed lines).

### Negative Control A — SIP

**Green.** 91/91 tests pass.

**Break.** In `sipXirr.ts` `calculateBenchmarkSip()`, shift **one** contribution's
benchmark alignment date by +1 day (the 4th contribution only).

**Red — confirmed.** 8 tests failed: SIP-BENCH-001, 002, 005, 006, 007, 008, 010
and the report assertion.

```
SIP-BENCH-002 / benchmarkSipXirr:
  production=0.12383202093731922 independent=0.12390501423302339
  variance=7.299e-05  tolerance=1e-6   FAIL
```

A single-day shift on a single contribution produced a variance 73× the
tolerance and was caught in every affected case.

**Restore → green.** 91/91 pass; `git diff` clean.

### Negative Control B — X-Ray

**Green.** 91/91 tests pass.

**Break.** In `overlap.ts`, replace the correct `Math.min(weightA, weightB)`
with the arithmetic mean `(weightA + weightB) / 2`.

**Red — confirmed.** 8 tests failed: OVERLAP-003, 004, 005, 006, 007, 009, 010
and the report assertion.

```
OVERLAP-003 / weightedOverlap:
  production=0.065  independent=0.05  variance=0.015  tolerance=1e-8  FAIL
OVERLAP-005 / weightedOverlap:
  production=1      independent=0.42  variance=0.58   tolerance=1e-8  FAIL
```

OVERLAP-005 is instructive: the corrupted formula produced exactly `1.0`, which
still satisfies the `0 ≤ overlap ≤ 1` bounds check and would have passed a
bounds-only test. Only the value comparison against the independent oracle
caught it — evidence that the identity tests alone are not sufficient and the
oracle is doing real work.

**Restore → green.** 91/91 pass; `git diff` clean.

### Negative Control B2 — X-Ray core formula (added after migration 0044)

Re-run for extra confidence once the X-Ray path had been validated live.

**Green.** 131/131 tests pass.

**Break.** In `lookThrough.ts`, drop the portfolio weighting from the core
formula — use the raw within-fund weight instead of
`portfolioWeight × holdingWeightInFund`.

**Red — confirmed.** **16 tests failed.**

```
XRAY-008 / exposures[OA].effectiveWeight:
  production=0.9   independent=0.54  variance=0.36   tolerance=1e-8  FAIL
XRAY-005 / exposures[S2].effectiveWeight:
  production=1.2   independent=0.6   variance=0.6    tolerance=1e-8  FAIL
XRAY-003 / exposures.order:
  expected ['S3','S1','S2','S4'] to equal ['S1','S3','S2','S4']      FAIL
```

Three distinct failure modes surfaced from one defect: wrong magnitudes, an
**impossible weight of 1.2** (above the 1.0 ceiling), and a corrupted ordering
of the exposure vector. The ordering failure is worth noting — it means the
pack detects the defect even where a magnitude happens to coincide.

**Restore → green.** 131/131 pass; `git diff --numstat` shows zero changed
lines.

## 8. Reproduction

```
node scripts/ii-r5-certification/generate_cases.mjs      # 89 cases, byte-stable
python scripts/ii_r5_independent_reconciliation.py       # 89 oracle results
npx vitest run tests/unit/iiR5Certification.test.ts      # 91 tests, 698 comparisons
npx vitest run tests/unit/iiR5MathIdentities.test.ts     # 20 identity tests
npx vitest run tests/unit/iiR5NoFabrication.test.ts      # 20 no-fabrication tests
```

Artefacts: `cases.json`, `oracle_results.json`, `comparison_report.json`
(full Case / Metric / Production / Independent / Variance / Tolerance / Result
table for all 698 comparisons).
