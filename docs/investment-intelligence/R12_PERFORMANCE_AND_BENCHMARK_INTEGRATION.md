# R12 — Performance & Benchmark Integration (R4)

## R4 remains authoritative (spec section 42)

**Zero code changes to any R4 file.** Architecture discovery (section 2.5 of the discovery doc) found
`lib/engines/investment-intelligence` outside `tax/` — the entire XIRR/TWRR/benchmark engine — has
**no** `instrument_class` reference anywhere. It operates purely on `ii_transactions` cash flows and
`ii_holding_snapshots` values, which R12's manual-entry path writes in exactly the same shape mutual
funds do. This means R4 performance for an equity/ETF position works **today, with no R12-specific
code**, as long as the underlying rows exist — which R12's manual-entry service now provides.

## XIRR (spec section 43)

Canonical R4 XIRR applies unchanged. `purchase`/`sale`/`dividend` transactions are real signed cash
flows into the same XIRR input R4 already consumes for mutual funds — no equity-specific XIRR was
built.

## TWRR / return (spec section 44)

R12 does not verify TWRR end-to-end against a real multi-period equity position in this round (not
included in the 41-case certification or the live-DEV script — a disclosed gap, see
`R12_ACCEPTANCE_REPORT.md` outstanding items). The architectural claim (R4 is instrument-class-agnostic)
is grounded in code inspection, not yet in a dedicated R12 TWRR live/unit proof. Where R4 lacks
sufficient data for a position, it already reports "Not available" (pre-existing R4 behaviour,
unchanged) rather than a fabricated return.

## Benchmarks (spec sections 45-46)

R12 does not assign any benchmark to equity/ETF positions. No arbitrary benchmark is invented merely
to avoid an empty field (spec section 45's explicit prohibition) — a broad-equity-index benchmark for
direct stocks would be a real, non-trivial product decision (which index? weighted how?) intentionally
left to a future release. `ii_instrument_benchmarks` is untouched by R12.
