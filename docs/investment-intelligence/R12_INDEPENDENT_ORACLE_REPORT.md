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

**Original pass: 137 atomic comparisons across 41 cases** (8×1 identity + 10×2 holdings + 16×6 tax +
4×1 publishing + 3×3 xray = 137).

**2026-08-27 terminal certification continuation: expanded to 336 cases / 1,212 atomic comparisons**
(33×1 identity + 110×2 holdings + 140×6 tax + 20×1 publishing + 33×3 xray = 33+220+840+20+99 = 1,212),
via `scripts/r12-certification/generate_expanded_cases.py` — systematic boundary/permutation sweeps
per family (12-month anniversary sweep at 12 calendar anchors × 7 day-offsets; grandfathering
three-way-formula sweep across all 6 relative orderings of cost/FMV/sale-price × 4 magnitude variants
plus 3 tie cases; post-cutoff-acquisition-with-FMV-supplied date-gating proof; STCG/LTCG loss
preservation at both holding-period classes; 3 large-magnitude 5-6-figure disposals; a 25,000-unit
disposal as a page-boundary-flavored deterministic analogue of the live pagination negative control;
instrument-identity sharing patterns across 2-4-instrument groups including a second global scheme
(SEDOL) and country-scoped collision avoidance; 16 country/instrument-class publishing combinations;
10 X-Ray weight-split templates × 3 value scales including non-round percentages), not cosmetic
duplicates — every new case changes at least one boundary condition or numeric relationship that
produces a materially different expected result. Executed in `tests/unit/iiR12IndependentOracle.test.ts`
against the real production engines: **339/339 tests pass (336 cases + 3 meta-tests), 1,212 atomic
comparisons, 0 unexplained mismatches.**

One correction made during the expansion (not a production defect): the initial boundary sweep used
acquisition dates as far back as 2019, producing disposal dates before 2023-04-01 — outside the real
`computeDisposalTax()`'s covered tax-rule-version range (`ruleVersions.ts` starts at 2023-04-01,
correctly raising `NoApplicableRuleVersionError` for anything earlier, which is itself correct,
defensive engine behaviour, not a bug). The sweep's acquisition anchors were moved to 2022-2024 so
every generated disposal date falls inside the engine's real covered range, then re-verified clean.

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
