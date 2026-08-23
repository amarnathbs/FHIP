# R9 Forecasting Integration Contract

Forecasting remains authoritative (spec section 27). R9 implements zero independent forecast, retirement, investment-return, debt, or cross-border projection logic — confirmed by grep: no new file under `lib/engines/` recomputes any of these; `reviewCentreData.ts` imports `computeGoalsPagePayload` directly from `lib/services/goalsData.ts` rather than reimplementing it.

## Input contract R9 consumes (not defines)

| Field | Source |
|---|---|
| Investment value | `investments.current_value` (written by R3 publish/refresh or manual entry) |
| Goal allocation | `goal_funding_sources.allocation_percentage`/`allocated_amount` |
| Contributions | `investments.annual_contribution`, `retirement_accounts` contribution fields, via `computeAllocatedMonthlyContribution()` |
| Expected-return assumption | `forecast_global_assumptions` / `forecast_assumptions` (Module 10) — never R4's historical XIRR/CAGR (spec section 29) |
| Goal target / target date | `user_goals.target_amount`/`target_date` |
| Currency | `user_goals.currency_code`, `investments.currency_code` — converted only via existing FHIP canonical FX, never an R9-invented rate |
| Forecast version | `goal_forecasts.model_version` (Module 7, `goals-1.0.0`) or `forecast_runs.engine_version`/`input_hash` (Module 10) |

## Expected-return authority (spec sections 29-30)

Verified by reading `lib/engines/forecast/assumptions.ts` and `lib/engines/goalForecast.ts`: both draw return-rate assumptions from `forecast_global_assumptions`/`goal_planning_config`, never from R4's `ii_analytics_results` performance figures. R9 adds no code path that feeds R4 historical performance into any assumption table.

## Staleness / cache (spec sections 32-34)

- **Module 10**: `forecast_runs` cache key = `(input_hash, engine_version, status='completed')`. `input_hash` is a sha256 of the full resolved calculator input (including `investments.current_value`), so any investment or goal change is structurally a cache miss on the next `/api/forecast/run` — no explicit invalidation call is needed or was added.
- **Module 7**: `computeGoalsPagePayload()` computes `track_status`/`fundingGapAtTargetDate` live on every call (confirmed: its own code comment states it deliberately avoids "writing a new goal_forecasts row on every view" — i.e. it never serves a cached/stale result in the first place for the primary Goals page).
- **R9's own persisted layer** (`ii_review_items`) is the one place R9 itself could serve stale output, and it is handled the same way Module 7 handles its own persisted history: `resolveVanishedItems()` in `reviewCentreData.ts` marks a review item `resolved` the moment a re-run no longer reproduces its identity_key, rather than leaving a stale item displayed as current.

## Goal on-track status / gap (spec sections 34-36)

R9 reads `goal_forecasts`-shaped live output (`g.forecasts.base.trackStatus`, `.fundingGapAtTargetDate`, `.targetAmountFuture`, `.projectedTargetDateValue`) directly from `computeGoalsPagePayload()`'s return value — the exact vocabulary (`ahead_of_track|on_track|at_risk|off_track|fully_funded|unable_to_assess`) is Module 7's own, unmodified. No new thresholds were invented for track status itself; R9 only adds a threshold for *which* track statuses warrant a review item (`off_track`, `at_risk` — configurable via `ii_review_rule_registry`).

## Retirement (see R9_RETIREMENT_INTEGRATION.md)
