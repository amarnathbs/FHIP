# R4 — TWRR Certification

## Algorithm

Production (`lib/engines/investment-intelligence/twrr.ts`,
`twrr-chain-linked-eod-v1`): sub-period boundaries = union of {period
start, every external-flow date, period end}; sub-period return
`(V_end,k − CF_k)/V_start,k − 1`; chain-link `Π(1+r_k) − 1`.

Independent oracle (`scripts/ii_r4_independent_reconciliation.py`,
`oracle_twrr`): independently re-derives sub-period boundaries from the
same raw valuation/flow lists (never reads production's own
`subPeriods` output), applies the identical documented end-of-day
convention, and chain-links from scratch in Python.

## The end-of-day cash-flow convention — the single most important
## documented detail in this file

A reported valuation on an external-flow date is **already post-flow**:
if a portfolio was worth 1300 from market performance alone by the flow
date and the investor then added 1500, the number the engine is given for
that date is **2800** (1300 + 1500), not 1300. The engine subtracts the
flow from the reported value to isolate the closing value of the prior
sub-period; the next sub-period's opening value is the full reported
(post-flow) number.

This convention is not a minor footnote — **7 of the first 15 TWRR unit
tests were written incorrectly** during initial development because the
test author (this same session) modeled the boundary valuation as
pre-flow. Every failure was a genuine test-construction error, not an
engine defect: re-deriving the fixtures under the documented convention
made every case pass with exact closed-form expected values (e.g.
`TWRR-002`: `1.1 × 1.1 − 1 = 0.21` exactly; `TWRR-003`:
`1.2 × (550/600) − 1 = 0.10` exactly). This is recorded here deliberately
because it is exactly the kind of "different convention in different
places" risk the spec warns about — the convention is now stated once, in
the engine file header, this document, and applied identically by the
independent Python oracle.

## No interpolation across a missing boundary

`TWRR-009` / `TC047` (in the 50-case pack): a required valuation is
missing exactly on an external-flow date. Both production and the oracle
independently return `unavailable` (`MISSING_BOUNDARY_VALUATION`) rather
than interpolating a value to keep a continuous-looking series.

## Unit test pack: TWRR-001 to TWRR-015

`tests/unit/iiR4Twrr.test.ts` — 15/15 passing. Covers: no external flows
(Identity A), one contribution, one withdrawal, multiple contributions,
contribution during a falling/rising market, zero-return period, negative
period, incomplete valuation history (unavailable, not interpolated),
large external flow relative to portfolio size, same-day flow handling,
chain-link accuracy (production's own compounded output cross-checked
against an independently-recomputed chain-link of its own sub-periods),
a case demonstrating XIRR and TWRR would materially diverge under a
badly-timed large contribution, and a portfolio-refresh case.

## Manual reconciliation cases

See `R4_MANUAL_RECONCILIATION.md` TWRR-M1 (`1.1 × 1.1 − 1 = 0.21`) and
TWRR-M2 (`1.2 × (550/600) − 1 = 0.10`), both exact fractions solvable by
hand.

## 50-case pack coverage

TC021-030 (multi-scheme portfolio / TWRR): 11 randomly-generated
multi-sub-period cases (2-4 sub-periods each, contributions and
withdrawals, market returns from -15% to +25%). All 11 pass against the
independent oracle within `1e-6`. TC047 is the dedicated missing-boundary
pathological case.
