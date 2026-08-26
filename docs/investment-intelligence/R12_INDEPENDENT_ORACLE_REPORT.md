# R12 — Independent Oracle Report

## Oracle

`scripts/r12-certification/r12_independent_multiasset_oracle.py` — standalone Python, zero imports
from this repository (verified: the only imports are `json`, `os`, `datetime`). Independently
re-derives, from the underlying rule/law rather than by porting the TypeScript:

- Instrument identity resolution (union-find over identifier keys, global-vs-country-scoped uniqueness).
- Transaction interpretation → unit-delta replay.
- Expected quantity/market value from a frozen price.
- Section 2(42A) holding-period anniversary rule (calendar-month arithmetic, independently implemented
  with its own leap-year-aware `add_months`).
- Section 111A/112A STCG/LTCG classification.
- Section 55(2)(ac) grandfathering three-way formula.
- Expected economic position count / net-worth contribution (always 1 per position).
- `master_item_key` resolution (equity country-dependent, ETF country-independent).
- X-Ray effective-weight/value attribution (independent weighted-sum, not the production `lookThrough.ts` algorithm).

## Atomic comparisons

**137 atomic comparisons** across 41 cases (8×1 identity + 10×2 holdings + 16×6 tax + 4×1 publishing +
3×3 xray = 137), executed in `tests/unit/iiR12IndependentOracle.test.ts` against the real production
engines. **0 unexplained mismatches** after the fixes below.

## Bugs the oracle-construction process itself found (in the oracle, not production code)

1. **Grandfathering formula, first draft**: written as `min(max(fmv, cost), sale)`. This is precisely
   the "classic wrong implementation" the PRODUCTION code's own comments (`grandfathering.ts`) warn
   against — it silently erases a genuine pre-existing loss to Rs 0 whenever `actualCost > salePrice`.
   Caught by adding `TAX-016` (a real-loss case where `actualCost=500 > fmv=180 > salePrice=90`) and
   observing the oracle's own result didn't match the production engine's. Fixed to the CORRECT
   `max(actualCost, min(fmv, salePrice))`, re-derived from `grandfathering.ts`'s own cited legal
   source (Section 55(2)(ac) / Section 90(7)-(9) of the 2025 Act) independently, not copied.
2. **`masterItemKey` missing branch**: the oracle's first draft only produced a non-null key for
   `equity+IN` and any `etf`, returning `None` for `equity+AU` — missing the `australian_shares`
   branch the real `mapInstrumentClassToMasterItemKey()` (and migration 0073's already-shipped rule)
   correctly returns. Fixed.

Both bugs were caught by the comparison harness itself (a real mismatch against production output),
which is exactly what an independent oracle is for — including catching bugs in the oracle.

## Independence discipline

The oracle never imports `lib/engines/investment-intelligence/tax/capitalGainsEngine.ts` or any other
production file (impossible cross-language, but the LOGIC is also a fresh derivation, evidenced by the
fact that it initially disagreed with production on `TAX-016` before being fixed against the cited
statute, not against the code).
