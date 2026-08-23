# ADR-006: Goals and Forecasting Integration

## Status
Accepted (R0)

## Context
FHIP Goals and FHIP Forecasting are both explicitly required to remain canonical (design principles 10, 11, 12). Discovery confirmed both already have working, live mechanisms Investment Intelligence could either integrate with or accidentally duplicate/conflict with: `goal_funding_sources`' allocation-percentage cap (`checkFundingAllocation()`) and `investmentCalculator.ts`'s `master_item_key`-driven asset-class resolution (`R0_CURRENT_STATE_DISCOVERY.md` sections 6–7).

## Decision
Investment Intelligence integrates with both existing mechanisms rather than replacing them. Goal linkage: `ii_goal_allocations` records the Investment-Intelligence-side view (anchored to the pre-publication canonical position, for republish/reconciliation resilience) while writing through to `goal_funding_sources` so the existing 100%-allocation cap applies unchanged (`R0_GOAL_INTEGRATION_CONTRACT.md`). Forecasting: publishing writes into the exact `investments` columns `investmentCalculator.ts` already reads (`current_value`, `annual_contribution`, `master_item_key`, `currency_code`), requiring no calculator changes (`R0_FORECASTING_CONTRACT.md`).

## Alternatives considered
1. **A new Investment-Intelligence-specific goal-linkage table with its own allocation-cap logic, independent of `goal_funding_sources`** — rejected: risks the two mechanisms disagreeing (a position could be over-allocated by Investment Intelligence's own accounting while `goal_funding_sources` reports it as fine, or vice versa), which is precisely the kind of double-counting-adjacent bug design principle 4 is meant to prevent generally.
2. **A new investment-specific forecast calculator inside Investment Intelligence** — rejected outright: explicitly forbidden by design principle 12 ("must not create a competing household forecasting engine") and the task's own non-goals ("do not build any analytics").
3. **Bypass `master_item_key` and add a new `asset_class` field Forecasting must be taught to read** — rejected: `master_item_key` is already the *reliable* signal per two already-fixed production bugs referenced in the calculator's own code comments (FHIP-FC-INV-001/002, `R0_CURRENT_STATE_DISCOVERY.md` section 7); introducing a second, competing classification field would risk reintroducing the exact class of bug already fixed once.

## Consequences
- Positive: zero changes to `goalFundingAllocation.ts`, `goalForecast.ts`, `investmentCalculator.ts`, or `netWorthCalculator.ts`.
- Positive: existing tested behaviour (the 100%-cap rejection message, the `master_item_key`-driven return-rate resolution) is inherited for free and stays consistent for both manually-entered and Investment-Intelligence-published rows.
- Negative: `ii_goal_allocations` and `goal_funding_sources` must be kept in sync by the publishing/allocation write path — a real synchronization responsibility for R1 to implement correctly (flagged as an explicit R1 requirement, not automatic).

## Migration implications
`ii_goal_allocations` is new and additive; no existing Goals or Forecasting table/column changes.

## Testing implications
R1 must test that writing an `ii_goal_allocations` row correctly produces (or updates) the matching `goal_funding_sources` row, and that the existing `evaluateAllocation()`/`checkFundingAllocation()` unit tests continue to pass unmodified against Investment-Intelligence-originated allocations.
