# R9 Architecture — Goals, Forecasting & Review Centre

## Governing principle (spec section 148)

```
Investment Intelligence            (unchanged: accounts/holdings/transactions/tax lots/valuations/performance)
        |  investment truth, published into `investments` via the existing R3 bridge
        v
Goal Allocation                    (ii_goal_allocations, now correctly wired -> goal_funding_sources)
        |
        v
Existing FHIP Goals                (user_goals / goal_funding_sources / goal_forecasts — UNCHANGED schema, UNCHANGED cap logic)
        |
        v
Existing FHIP Forecasting          (Module 10 forecast_runs / Module 7 goalForecast.ts — UNCHANGED, consumed live)
        |
        v
Investment Review Centre           (NEW: ii_review_items, deterministic rule engine)
```

No parallel `ii_goals`, `ii_forecasting_engine`, `ii_retirement_goals`, or `ii_net_worth_engine` was created (spec section 5) — confirmed absent from migration `0067` and from every new service/engine file.

## What R9 actually built

1. **Fixed** `lib/services/investment-intelligence/goalAllocations.ts` — the orphaned R1-era `ii_goal_allocations` write path now (a) verifies the caller owns any `linkedInvestmentId` before referencing it, (b) calls the existing `checkFundingAllocation()` <=100% cap check before every write, (c) supports update/remove lifecycle (supersede/removed, never a silent overwrite or hard delete), (d) persists `linked_investment_id` on the row itself (new column, migration `0067` section 0) so a later update/remove can find the exact `goal_funding_sources` counterpart it produced instead of affecting every investment-sourced funding source on the goal.
2. **Added** `lib/services/investment-intelligence/portfolioAttribution.ts` — pure, pagination-safe aggregation over `investments` + `goal_funding_sources` (goal-linked current value, portfolio allocated/unallocated split). Computes no new financial truth (spec sections 6, 24, 25).
3. **Added** the Review Centre: migration `0067` (`ii_review_items`, `ii_review_rule_registry`), engine `lib/engines/investment-intelligence/reviewCentre.ts` (9 deterministic rules, pure functions), service `lib/services/investment-intelligence/reviewCentreData.ts` (fetch -> rule -> upsert-with-dedup).
4. **Added** API routes: `GET/GET-one /investment-intelligence/goals[/:id]`, `POST /investment-intelligence/goals/:id/allocations`, `PUT/DELETE /investment-intelligence/goal-allocations/:id`, `GET/GET-one /investment-intelligence/review[/:id]`, `POST .../acknowledge`, `POST .../dismiss`, `POST /investment-intelligence/review/refresh`, `POST /investment-intelligence/forecast/refresh`.
5. **Added** a minimal Review Centre UI (`app/(app)/investment-intelligence/review/page.tsx` + `components/investment-intelligence/ReviewCentreClient.tsx`).

## What R9 deliberately did NOT build

- No new forecast engine. `POST /investment-intelligence/forecast/refresh` does not recompute forecasts — Module 10's `forecast_runs` cache already invalidates automatically via `computeForecastInputHash`, and Module 7's `computeGoalsPagePayload()` is already computed live on every read. The endpoint's actual job is refreshing Review Centre observations (documented at the top of its route file so the non-obvious design choice isn't silently lost).
- No recomputation of XIRR/TWRR (R4), overlap/concentration (R5), or capital gains tax (R6) — the Review Centre only reads their already-persisted, already-certified output tables.
- No change to `goal_funding_sources`' own schema, RLS, or cap-check semantics — reused exactly as-is.
- No UI rebuild of the Goals or Forecasting pages themselves — the Review Centre is a new, additive surface; deeper integration into the existing Goals page ("Linked Investments" / "Forecast Status" panels per spec section 57) is a disclosed, deferred UI-polish item (see `R9_ACCEPTANCE_REPORT.md`'s Known Limitations), not a correctness gap.

## R10 output contract (spec sections 135-136)

`GET /investment-intelligence/goals` returns, per goal: `currentAllocatedValue`, `forecastProjectedValue`, `forecastTargetValue`, `forecastGap`, `trackStatus`, `forecastModelVersion`, `openReviewItemCount`. `GET /investment-intelligence/review` returns paginated `ii_review_items` rows with full evidence/provenance. A future R10 report package can consume both without recomputing anything — this is the stable contract spec section 136 asks for.
