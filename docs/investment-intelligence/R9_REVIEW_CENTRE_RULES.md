# R9 Review Centre — Rule Registry

Rules are stored in `ii_review_rule_registry` (migration `0067`), versioned (`rule_key`, `rule_version`, unique together), effective-dated, and trusted-write-only (RLS: `for select using (true)`, no insert/update/delete policy for the `authenticated` role — same pattern as `forecast_global_assumptions`, migration `0013`). Ordinary users cannot alter thresholds (spec section 120); only the service-role key can write, and no application code path exposes a write to this table.

Every review item records `rule_key` + `rule_version` + `review_engine_version` (`REVIEW_ENGINE_VERSION = 'review-1.0.0'`, `lib/engines/investment-intelligence/reviewCentre.ts`) — spec section 133.

## Rule set (seeded, `rule_version = 'r9-1.0.0'`)

| rule_key | review_type / category | Severity | Threshold | Source module |
|---|---|---|---|---|
| `unallocated_investment` | goal / `unallocated_investment` | info | `unallocatedValue > 0` | II publishing + `goal_funding_sources` |
| (over-allocation defensive detector) | goal / `goal_allocation_conflict` | high | `allocatedPct > 100` | same |
| `goal_forecast_gap` | goal / `goal_forecast_gap` | medium | `trackStatus in (off_track, at_risk)` AND has an active funding source | Goals (`goal_forecasts`-shaped live output) |
| `stale_valuation` | data_quality / `stale_valuation` | low | II-published, `ageDays(ii_last_refreshed_at) > 90` | II publishing |
| `reconciliation_open` | data_quality / `unresolved_instrument` | medium | any open `ii_reconciliation_cases` row | II data quality |
| `benchmark_underperformance` | performance / `benchmark_underperformance` | medium | `scheme_active_return.value.activeReturn < -0.02` at `quality_status='ok'` | R4 `ii_analytics_results` |
| `sip_interruption` | sip / `sip_interruption` | low | >=2 missed instalments on a `CONFIRMED_SOURCE`/`HIGH_CONFIDENCE`, regular-cadence series | R5 `ii_sip_series` |
| `exit_load_exposure` | tax_cost / `exit_load_exposure` | low | `exit_load_pct > 0` | R6 `ii_capital_gains_computations` |
| `tax_lot_incomplete` | tax_cost / `tax_lot_incomplete` | medium | `classification = 'unresolved'` OR `gain_type = 'unresolved'` | R6 `ii_capital_gains_computations` |

## Severity (spec section 45)

Deterministic 4-value scale `info < low < medium < high`, assigned per rule in the registry — never by an LLM (spec sections 40, 45), never user-editable (RLS + the bounded acknowledge/dismiss API — spec section 48).

## Prioritisation (spec section 51)

The UI (`ReviewCentreClient.tsx`) sorts by severity (`high` first) within the current status filter. Financial-materiality/time-horizon/data-confidence weighting beyond severity ordering was not implemented in this pass — a disclosed, non-critical scope reduction (see `R9_ACCEPTANCE_REPORT.md`).

## Compliance taxonomy (spec sections 40-42)

Every rule's `compliance_classification` is restricted at the type level to `Exclude<IiInsightClassification, 'personalised_advice'>` (`observation`/`education`/`simulation`) — enforced by TypeScript, the migration's CHECK constraint, and proven by `tests/unit/iiR9ReviewCentreEngine.test.ts`'s explicit "never produces personalised_advice" case. No rule recommends a specific product action (spec section 42).
