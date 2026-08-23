# R4 — XIRR Certification

## Algorithm

Production (`lib/engines/investment-intelligence/xirr.ts`,
`xirr-newton-bisection-v1`): safeguarded Newton-Raphson with bisection
fallback, grid-based bracket search, multiple-root detection via
de-duplicated bracket roots.

Independent oracle (`scripts/ii_r4_independent_reconciliation.py`,
`oracle-pure-bisection-v1`): **pure bisection, no derivative evaluation
anywhere in the solver**. This is a structurally different algorithm from
production, not the same method copy-pasted into a second file — Newton
uses the derivative of the NPV function to jump toward the root;
bisection only ever halves an interval. Two independent implementations
of the XIRR formula, in two different languages, using two numerically
different root-finding strategies, are compared for every certification
case.

## A real bug found and fixed during development

While writing `XIRR-006` (same-day flows: `-1000` and `+500` on the same
date, `+700` a year later — true root `r = 0.4` exactly), the initial
implementation of the safeguarded-Newton solver returned `r = 0.41`
instead of `0.40`. Root cause: the bisection-fallback step, on the very
first iteration, computed the same midpoint as the pre-loop initial guess
(`x = (a+b)/2` seeded before the loop, then a Newton failure fell back to
`(a+b)/2` again on iteration 1 — identical value), and a step-size-based
"convergence" check (`|xNext - x| < tolerance`) treated that coincidental
zero step as convergence even though the function value there was nowhere
near zero (`NPV(0.41) ≈ -3.55`, not `≈0`). Fixed by removing the step-size
convergence criterion entirely and requiring the **function value itself**
(`|NPV(x)| / scale < 1e-7`) to be small before returning — the bracket
`[a, b]` now strictly narrows every iteration and convergence is judged
only by proximity to an actual root. Confirmed via
`XIRR-006` (`toBeCloseTo(0.4, 5)`) — reproduced red, fixed, reproduced
green — before any commit.

## Precision & tolerances

| | Production | Oracle |
|---|---|---|
| Internal rate tolerance | `1e-9` | bracket width `< 1e-12` |
| NPV convergence tolerance | `1e-7` relative to cash-flow scale | `1e-9` relative to scale |
| Max iterations | 100 per bracket | 200 per bracket |
| Search domain | `r ∈ (-0.999999, 100]` | identical coverage |
| Display rounding | 4 decimal places of rate | n/a (oracle output not user-facing) |

Certification tolerance: `≤ 0.000001` absolute annual rate (spec section
78), applied without exception in the 50-case pack's XIRR cases (TC011-020,
TC046, TC050).

## Unit test pack: XIRR-001 to XIRR-020

`tests/unit/iiR4Xirr.test.ts` — 22 tests (20 named cases + 2 domain-guard
tests), all passing. Covers: single/multiple purchases, SIP-like
irregular dates, purchase+redemption+ending value, cash distributions,
same-day flows, negative/near-zero/very-high returns, 10-year history,
insufficient history, no-positive-flow, no-negative-flow, invalid dates,
a classically multiple-IRR-prone alternating cash-flow pattern (resolves
to either a genuine single root or an explicit ambiguity status — never
silently one of several), convergence-boundary (near-zero residual),
large values (₹9.5 crore scale), fractional flows, scheme-level and
portfolio-level aggregated cash flows.

## Manual reconciliation cases

See `R4_MANUAL_RECONCILIATION.md` XIRR-M1 (exact doubling, `r = 1.0`) and
XIRR-M2 (a genuinely irregular 3-flow case solved by hand via the
quadratic formula: `x² + x − 2.42 = 0` → `r ≈ 13.401345%`, production
returns `13.4013463%`, variance `< 0.00001` percentage points).
