# ADR-010: Reference Data Versioning

## Status
Accepted (R0)

## Context
Investment Intelligence depends on several categories of shared, versioned reference data: instrument masters, benchmarks/NAV series, fund look-through disclosures, and (in a future release) tax-rule sets. FHIP already has a proven precedent for exactly this shape of problem — Module 8's Financial Twin benchmark infrastructure (`benchmark_sources`, `benchmark_datasets`, `benchmark_update_runs`, `benchmark_metric_definitions`, `benchmark_target_ranges` — `R0_CURRENT_STATE_DISCOVERY.md` section 2), which already handles versioned, sourced, admin-governed reference data in production.

## Decision
Investment Intelligence's reference-data entities (`ii_benchmarks`, `ii_benchmark_series`, `ii_prices_nav`, `ii_instrument_benchmarks`, `ii_fund_holdings`, `ii_tax_rule_versions`) follow the same architectural pattern already proven by Module 8: world-readable, admin-write-only (via `admin_users`/`requireAdmin()`), append-only time series where the data is naturally a series (`ii_benchmark_series`, `ii_prices_nav`), and explicit version/effective-date fields on rule-shaped data (`ii_tax_rule_versions.version`, `effective_from`/`effective_to`). These are **new, sibling** tables to Module 8's benchmark tables, not a replacement or a merge — Investment Intelligence benchmarks (fund-vs-index comparisons) are a different subject from Financial Twin's benchmarks (household-vs-peer-cohort comparisons), even though the versioning *pattern* is shared.

## Alternatives considered
1. **Reuse `benchmark_datasets`/`benchmark_sources` directly for Investment Intelligence's fund/index benchmarks** — rejected: Module 8's benchmark tables are shaped around cohort-percentile household comparisons (`benchmark_cohorts`, `platform_cohort_aggregates`), a different data model from an instrument-vs-index time series; forcing Investment Intelligence's NAV/benchmark data through that shape would require compromising one or both use cases.
2. **No formal versioning on reference data — always overwrite with the latest value** — rejected: violates design principle 13 (deterministic, versioned, reproducible calculations) — a historical analytics result or forecast explanation must be able to cite exactly which reference-data version it used, which is impossible if reference data is overwritten in place.
3. **Version every reference-data change as a new full-table snapshot (copy-on-write at the table level)** — rejected as unnecessarily heavy: per-series-point/per-rule-set versioning (the chosen approach) gives the same reproducibility guarantee at far lower storage and query cost.

## Consequences
- Positive: Investment Intelligence's calculations (once built, in a future release) can cite an exact `calculation_version` plus the exact reference-data points used, fully reproducible — consistent with the existing `ResolvedAssumption.sourceReference` pattern already used by Forecasting (`R0_CURRENT_STATE_DISCOVERY.md` section 7).
- Positive: reuses a genuinely proven pattern (Module 8 is live, working code) rather than inventing a new one from scratch.
- Negative: some structural duplication between Module 8's benchmark tables and Investment Intelligence's `ii_benchmarks`/`ii_benchmark_series` (two "benchmark" concepts in the schema) — accepted as the lesser cost compared to forcing two genuinely different subjects through one shape.

## Migration implications
None for R0. All reference-data tables are new and additive; Module 8's existing benchmark tables are untouched.

## Testing implications
R1 must test that an `ii_analytics_results` row (once analytics exist, out of scope for R1 itself) can be reproduced byte-for-byte from its `input_snapshot` plus the cited reference-data version — an architectural requirement to verify once the relevant engine is built, not testable before then; R1 itself only needs to verify the versioning *shape* (append-only series, non-null version/effective-date fields) is correctly enforced by constraints.
