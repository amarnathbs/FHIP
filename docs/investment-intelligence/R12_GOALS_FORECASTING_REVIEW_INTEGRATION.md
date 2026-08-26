# R12 — Goals, Forecasting & Review Centre Integration (R9)

## Goal allocation (spec section 61)

**No code changes.** `goalAllocations.ts` has zero `instrument_class` references — it operates on
canonical position/publication ids generically. An equity/ETF position that reaches
`ii_fhip_publications` (once certified — see `R12_CANONICAL_INSTRUMENT_MODEL.md`) is eligible for
`ii_goal_allocations` exactly like a mutual fund, through the existing table, with no new
equity-specific allocation table.

## Allocation cap (spec section 62)

Unchanged — the existing ≤100% allocation safeguard in `goalAllocations.ts` is instrument-class-agnostic
and was not modified.

## Forecasting (spec section 63-64)

**No new forecast engine.** `forecastData.ts`/`investmentCalculator.ts` were inspected (architecture
discovery) and found to already reference generic `investment_type` buckets (`shares`, `etf`, etc.) —
the exact values `mapInstrumentClassToInvestmentType()` already produces for equity/etf, unchanged by
R12. Forecasting continues to use canonical effective return assumptions/policies — R12 does not
substitute a historical R4 return as a forward assumption.

## Review Centre (spec sections 65-66)

**Not extended this cycle.** No new Review Centre rule was registered for R12 (e.g. single-stock
concentration, missing cost basis for a manually-entered equity). This is a disclosed gap: R12's
X-Ray integration (`R12_XRAY_MULTI_ASSET_INTEGRATION.md`) provides the underlying concentration data a
future rule could consume, but authoring and registering a new `ii_review_rule_registry` rule was not
completed within this cycle's budget. Existing MF-based review rules are unaffected (R12 touches no
review-centre code).

## Compliance classification (spec section 66)

Not applicable this cycle (no new review rule was added), but the existing framework's discipline
(`OBSERVATION` / `EDUCATION` / `SIMULATION` / `PERSONALISED_ADVICE`, never a directive
"sell X / buy Y") is preserved by simply not adding new review content that could violate it.
