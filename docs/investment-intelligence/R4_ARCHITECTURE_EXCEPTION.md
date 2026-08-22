# R4 — Architecture Exceptions

## Deliberate, spec-sanctioned exception

**The independent Python oracle** (`scripts/ii_r4_independent_reconciliation.py`)
is architecturally separate from the "one authoritative production
implementation per formula" rule (spec sections 67-68) — and is
*required* to be, per spec sections 73-77. It duplicates the XIRR/TWRR/
blended-benchmark/risk-metric formulas in a different language, using a
deliberately different XIRR algorithm (pure bisection vs production's
Newton-bisection hybrid), specifically so it does NOT share any code path
with production and can genuinely disagree with it if production is
wrong. This is the one and only sanctioned duplication in this release,
and it is documented, isolated to `scripts/`, and never imported by any
production code path.

## No other exceptions

- No formula is implemented twice inside the application/production code
  path (`lib/engines/investment-intelligence/*.ts` is the single
  authoritative set).
- No React component computes a return, risk metric, or benchmark
  comparison inline — no such UI components exist yet in this release (see
  `R4_ACCEPTANCE_REPORT.md` — Known Limitations: no UI was built this
  session).
- No API route reimplements a formula — no R4 API routes exist yet this
  session (same limitation).
- `PerformanceEngine.ts` is the single orchestration point combining the
  sub-engines; no second orchestrator exists.

## NONE beyond the sanctioned oracle exception above.
