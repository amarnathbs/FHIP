# R9-P0 — Canonical Integration Discovery

Investment Intelligence R9 — Goals, Forecasting & Review Centre. Base: `origin/main` @ `56de52b` (FDH-4 Bank CSV adapter-coverage merge). Branch: `feature/investment-intelligence-r9-goals-forecasting-review`.

This document is the required R9-P0 output (spec sections 11-13): the actual current implementation of Goals, Forecasting, Retirement, Investments, Investment Intelligence, Dashboard/Net Worth, and Reports, read from live code — not from prior documentation. All findings below were independently verified by reading the cited files directly.

## 1. Goals — OWNER: Module 7 "Goal Planning™"

Canonical table `user_goals` (`0001_foundation.sql` base, expanded by `0009_module7_goals.sql`). Key columns: `id uuid`, `user_id`, `household_id`, `goal_name`, `goal_type`, `goal_category`, `target_amount`, `currency_code`, `target_date`, `status` (`draft|active|paused|on_hold|achieved|partially_achieved|missed|cancelled|archived`), `owner_member_id`/`beneficiary_member_id`, `planned_contribution_amount`, `linked_liability_id`.

Related tables (all `0009`): `goal_types` (config-driven catalogue with `forecast_logic_key`), `goal_planning_config`, **`goal_funding_sources`** (`source_type in (asset|investment|retirement|cash|manual|expected)`, `linked_asset_id`/`linked_investment_id`/`linked_retirement_id`, `allocated_amount`, `allocation_percentage` — **the pre-existing, live allocation mechanism**), `goal_contributions`, `goal_milestones`, `goal_forecasts` (immutable per-run snapshot rows), `goal_snapshots`.

Service: `lib/services/goalsData.ts` (`computeGoalsPagePayload` — live, non-persisting; `loadGoalsPage` — persists an immutable history row). Cap enforcement: `lib/services/goalFundingAllocation.ts`'s `checkFundingAllocation()`/`evaluateAllocation()` — sums `allocation_percentage` across every other active funding source referencing the same `linked_investment_id`/`linked_asset_id` and rejects if the total would exceed 100%.

Goal projection engine: `lib/engines/goalForecast.ts` (`MODEL_VERSION = 'goals-1.0.0'`), 8 category calculators keyed by `forecast_logic_key`. `TrackStatus = 'ahead_of_track'|'on_track'|'at_risk'|'off_track'|'fully_funded'|'unable_to_assess'`. `CategoryForecastResult` carries `targetAmountFuture`, `projectedTargetDateValue`, `fundingGapAtTargetDate`, `trackStatus` — **this is the exact vocabulary and gap figure R9 consumes for goal-forecast-gap review items**.

API: `app/api/goals/**` (CRUD, funding-sources, contributions, milestones, archive/complete/pause/resume, forecast). UI: `app/(app)/goals/**`.

## 2. Forecasting — OWNER: Module 10 "Forecasting Engine"

A **distinct engine** from Module 7's `goalForecast.ts`. Location: `lib/engines/forecast/` — `engine.ts` (`FORECAST_ENGINE_VERSION = 'forecast-1.6.0'`, `runForecastCalculation`, `computeForecastInputHash`), one calculator per type (`netWorthCalculator`, `goalCalculator`, `investmentCalculator`, `debtCalculator`, `retirementCalculator`, `crossBorderCalculator`, `resilienceCalculator`).

Service `lib/services/forecastData.ts`'s `buildCalculatorInput()` reads live FHIP tables directly. Critically, `forecastType='investment'` reads the `investments` table filtered only by `user_id`/`is_active` — **no `source_type` filter**. Since R3 publishing writes II-published positions into that same `investments` table, **Forecasting already sees II-published investments automatically, with no code change required.**

Cache/versioning: `forecast_runs` reuses a cached row only if `input_hash` (sha256 over the deep-sorted resolved calculator input) **and** `engine_version` **and** `status='completed'` all match. Because `input_hash` is derived from the live `investments.current_value` read, any change to that value (including an II publish/refresh) produces a new hash on the next run — a structural, automatic cache-miss with no explicit "invalidate on publish" hook required. `engine.ts`'s header explicitly documents the prior stale-cache defect this two-part key was built to prevent.

Tables: `forecast_profiles`, `forecast_scenarios`, `forecast_assumptions`, `forecast_global_assumptions`, `forecast_runs`, `forecast_results`, `forecast_explanations` (`0013`, seed/fix in `0014-0016`, `0024`, `0028`). API: `app/api/forecast/**`.

## 3. Retirement — three coexisting representations

1. **`retirement_accounts`** (`0003_module2.sql`) — actual account balances, independent of Goals.
2. **Retirement as a Goal category** — `goal_types` rows with `category='retirement'`, projected by `goalForecast.ts`'s `retirement` calculator.
3. **Retirement Forecasting** — `lib/engines/forecast/retirementCalculator.ts`, driven by `forecastData.ts`'s `forecastType='retirement'`, reads `retirement_accounts` directly plus a 3-tier timing hierarchy (`forecast_profiles.retirement_date` → DOB+`retirement_age` → `retirement_timing_override_months`, added by `0028` for fix FHIP-FC-RET-001).

A goal links to a `retirement_accounts` row via `goal_funding_sources.linked_retirement_id`.

## 4. Investment Intelligence

**`ii_goal_allocations`** (`0034_ii_publishing_goal_allocations.sql`) already existed pre-R9, with RLS (`own ii_goal_allocations`, `auth.uid()=user_id`), a service (`lib/services/investment-intelligence/goalAllocations.ts`) and an API route (`app/api/investment-intelligence/goal-allocations/route.ts`, GET/POST). It was **real but orphaned**: `investmentPublicationService.ts` (the real R3 publish flow) never called it, no UI referenced it, and — the concrete R9-P0 finding — its `createOrUpdateGoalAllocation()` inserted into `goal_funding_sources` **without ever calling `checkFundingAllocation()` first**, meaning the <=100% cap was not actually enforced for allocations created through this path. R9 fixes this (see `R9_GOAL_ALLOCATION_CONTRACT.md`).

**R3 publishing** (`0042_ii_r3_fhip_publishing_bridge.sql`, `lib/services/investment-intelligence/investmentPublicationService.ts`): every real publish/link/unlink/refresh write targets `.from('investments')` only (confirmed at every call site). `ii_fhip_publications` gained `account_id`/`instrument_id` identity columns and `uidx_ii_fhip_publications_one_active_position` — a DB-level unique index guaranteeing at most one `'published'` row per `(account_id, instrument_id)`, which is the actual no-double-count mechanism R9 relies on rather than re-implementing.

**R4** (`0043`): `ii_analytics_results` was **rebuilt from the R1-era placeholder** (renamed to `ii_analytics_results_r1_legacy`) with a new shape: `scope_type`/`scope_id`/`metric_key`/`metric_version`/`engine_version`/`quality_status`/`result_value jsonb`. `metric_key='scheme_active_return'` at `scope_type='scheme'` carries `result_value.value.activeReturn` (a CAGR-fraction difference vs. benchmark) — this is what R9's benchmark-underperformance review rule reads.

**R5** (`0044`): `ii_sip_series` (`cadence`, `detection_confidence`, `latest_contribution_date`, `detection_method_version`) — no explicit "interrupted" flag; R9 derives interruption deterministically from cadence + latest-contribution-date, restricted to `CONFIRMED_SOURCE`/`HIGH_CONFIDENCE` detections on a defined cadence only.

**R6** (`0059`): `ii_capital_gains_computations` (`classification`, `gain_type`, `exit_load_pct`, `engine_version`) — `classification='unresolved'`/`gain_type='unresolved'` is the real data-quality signal R9 reads (not a separately-tracked "cost_base_status" as initially assumed — corrected during implementation).

Country scope: India fully implemented (CAMS/KFintech parsers); Australia is schema-level stubbed only (no AU II parser exists yet), consistent with prior R1-R6 findings.

## 5. Dashboard / Net Worth — OWNER: `lib/services/dashboardData.ts` + `lib/engines/dashboard.ts`

`loadDashboard()` sums every active `investments` row identically regardless of `source_type` — no dashboard-side dedup logic exists. Double-counting is prevented entirely by the R3 publish mechanism's one-row-per-position invariant plus the DB-level `uidx_ii_fhip_publications_one_active_position` constraint. `source_type` is an audit/origin marker only, never a net-worth inclusion/exclusion flag.

## 6. Reports — OWNER: Module 9

`reports`/`report_sections`/`report_snapshots`/`report_generation_runs` (`0010`, extended `0022`, `0024-0027`). Out of scope for R9 (spec section 135) — R9 exposes a stable output contract for a future R10 to consume (see `R9_ARCHITECTURE.md`).

## Ownership determination (spec section 13)

| Truth | Owner | Confirmed |
|---|---|---|
| Goal truth | `user_goals` (Module 7) | Unchanged by R9 |
| Investment truth | Investment Intelligence + `investments` (post-R3-publish) | Unchanged by R9 |
| Forecast truth | Module 10 (`lib/engines/forecast/`) + Module 7's `goalForecast.ts` | Unchanged by R9 — consumed, not recomputed |
| Retirement truth | `retirement_accounts` + Module 10's `retirementCalculator.ts` | Unchanged by R9 |
| Goal-to-investment allocation | `goal_funding_sources` (authoritative for money/forecast) + `ii_goal_allocations` (II-side audit mirror, now correctly wired) | R9 fixes the wiring, does not replace the table |
| Review Centre observations | New — `ii_review_items` (migration `0067`) | Genuinely new, no prior collision |

## No architectural conflict found

No genuine conflict with existing FHIP Goals/Forecasting ownership was found. R9's actual job, once discovery was complete, was narrower than a literal reading of the release spec's maximal framing suggests: the money-and-forecast-integration plumbing (goal_funding_sources -> Forecasting) already existed and worked; R9's real additions are (a) fixing the allocation-cap enforcement gap in the orphaned II-side write path, (b) an entirely new Review Centre, and (c) provenance/UI surfacing. Per spec section 148, this is an integration, not a duplication — the hard-stop condition does not apply and implementation proceeded.
