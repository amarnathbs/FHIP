# R9 Retirement Integration

Retirement is governed entirely by FHIP's existing Retirement/Forecasting logic (spec section 37) — `retirement_accounts` (Module 2) and `lib/engines/forecast/retirementCalculator.ts` (Module 10), or a `goal_category='retirement'` goal projected by Module 7's `goalForecast.ts`. R9 adds no second retirement engine, confirmed by the absence of any `ii_retirement*` table or file.

## Investment-to-retirement linkage (spec section 38)

An investment becomes "retirement money" only through the existing `goal_funding_sources.linked_retirement_id` mechanism (linking to a real `retirement_accounts` row) or by being allocated, via the R9-fixed `ii_goal_allocations` -> `goal_funding_sources` path, to a goal whose `goal_category = 'retirement'`. R9 never automatically classifies an investment as retirement money — allocation is always an explicit user action (spec section 38, "do not automatically classify every investment as retirement money").

## R3 publishing target (disclosed structural note, not an R9 defect)

Migration `0042` added the same `source_type`/`ii_publication_id` columns to `retirement_accounts` as to `investments`, but — per that migration's own header comment — "No R3 production write path targets these new columns"; Investment Intelligence's real publish flow (`investmentPublicationService.ts`) writes only to `investments`, never `retirement_accounts`, in production today. This means an II-detected position that is economically a retirement account (e.g. an NPS-linked fund) is currently published as a regular investment and can only be attributed to retirement via a goal_funding_sources link to a `retirement`-category goal — not via a direct `retirement_accounts` publication. This is a pre-existing R1-R3 architectural boundary, not something R9 introduced or is scoped to change; R9 works correctly within it (retirement-goal allocation and forecast-gap review items both function via the goal-category path, verified in `tests/unit/iiR9ReviewCentreEngine.test.ts`'s `detectGoalForecastGap` cases).

## Retirement double-counting

No new retirement balance table was created; `retirement_accounts` remains the single row per account, summed exactly once by both Module 10's `retirementCalculator.ts` and (when goal-linked) `computeAllocatedMonthlyContribution()`'s contribution-attribution logic — the latter is display/forecast-input attribution, never a second balance (same invariant as investment goal allocation, spec section 25).
