# R9 Review Provenance

Every `ii_review_items` row answers "why am I seeing this?" (spec section 46) via five columns, all populated by every one of the 9 rules (verified in `reviewCentre.ts` — no rule leaves any of these null):

- `source_module` — one of `goals|forecasting|retirement|ii_publishing|ii_r4_performance|ii_r5_sip_xray|ii_r6_tax|ii_data_quality`.
- `source_record_id` — the upstream row/entity the evidence came from (an `investments.id`, `user_goals.id`, `ii_reconciliation_cases.id`, an R4 `scope_id`, an `ii_sip_series.id`, or an `ii_capital_gains_computations.id`, depending on the rule).
- `source_record_version` — the upstream version identifier where one exists (`goal_forecasts`/live-payload `modelVersion`, `ii_analytics_results.engine_version`, `ii_sip_series.detection_method_version`, `ii_capital_gains_computations.engine_version`).
- `rule_key` + `rule_version` — which deterministic rule, at which version, produced this item.
- `review_engine_version` — the Review Centre engine build itself (`review-1.0.0`), independent of the upstream module's own version.
- `evidence` (jsonb) — the exact numbers the rule decision was based on (e.g. `{fundingGapAtTargetDate, targetAmountFuture, forecastModelVersion}` for a goal-gap item) — never a restated claim without the numbers behind it.

## No raw document exposure (spec section 61)

`evidence` and `source_record_id` reference internal row/entity IDs only — never a storage path, signed URL, or raw statement content. Confirmed by reading every `evidence: {...}` literal in `reviewCentre.ts`: none includes a document ID or file reference field.

## Chain of custody example (matches spec section 46's worked example shape)

```
Review Item (goal_forecast_gap, rule_version r9-1.0.0)
  -> evidence.fundingGapAtTargetDate, evidence.forecastModelVersion
  -> Goal Forecast (Module 7 goalForecast.ts, live-computed, model_version 'goals-1.0.0')
  -> Goal Allocation (goal_funding_sources row, linked_investment_id)
  -> Investment Holding (investments.id, current_value)
  -> [for an II-published row] ii_fhip_publications -> ii_holding_snapshots -> ii_transactions -> ii_source_documents (internal ID only, never exposed by any R9 API)
```

`GET /investment-intelligence/goals/:id` and `GET /investment-intelligence/review/:id` are the two API surfaces that expose this chain to the client; neither ever returns a `ii_source_documents` storage path.
