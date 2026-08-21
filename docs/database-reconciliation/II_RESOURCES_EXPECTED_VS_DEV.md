# Investment Intelligence + Resources — Expected vs Live DEV

> **Expected** = the certified clean rebuild of `supabase/migrations/0001`-`0049`
> into an empty PostgreSQL 18 database.
> **DEV** = live `vqycarelcoijzwlpkpcz`, read through the PostgREST OpenAPI schema
> (`GET /rest/v1/` with the service-role key), which enumerates every exposed
> relation and its columns, types, defaults and nullability.
>
> Production (`twwpnltizhtjxhamyoxt`) was never contacted.

## Result

**54 of 54 in-scope tables classified MATCH. 0 require action.**

Column-level comparison across all in-scope tables: **676 columns compared, 0 missing in DEV, 0 extra in DEV, 0 type mismatches.**

Classification legend: MATCH / MISSING / PARTIAL / EXTRA / CONFLICT / OWNERSHIP_AMBIGUOUS / DATA_DRIFT / POLICY_DRIFT / SEED_DRIFT.

| Module | Object | Type | Expected | DEV | Classification | Required action |
|---|---|---|---|---|---|---|
| Investment Intelligence | `ii_accounts` | table | 13 cols, RLS on | 13 cols present | MATCH | None |
| Investment Intelligence | `ii_analytics_results` | table | 17 cols, RLS on | 17 cols present | MATCH | None |
| Investment Intelligence | `ii_analytics_results_r1_legacy` | table | 10 cols, RLS on | 10 cols present | MATCH | None |
| Investment Intelligence | `ii_audit_events` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Investment Intelligence | `ii_benchmark_series` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Investment Intelligence | `ii_benchmarks` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Investment Intelligence | `ii_document_parse_runs` | table | 23 cols, RLS on | 23 cols present | MATCH | None |
| Investment Intelligence | `ii_fhip_publications` | table | 35 cols, RLS on | 35 cols present | MATCH | None |
| Investment Intelligence | `ii_fund_holdings` | table | 8 cols, RLS on | 8 cols present | MATCH | None |
| Investment Intelligence | `ii_fund_holdings_lines` | table | 23 cols, RLS on | 23 cols present | MATCH | None |
| Investment Intelligence | `ii_fund_holdings_snapshots` | table | 13 cols, RLS on | 13 cols present | MATCH | None |
| Investment Intelligence | `ii_goal_allocations` | table | 12 cols, RLS on | 12 cols present | MATCH | None |
| Investment Intelligence | `ii_holding_snapshots` | table | 16 cols, RLS on | 16 cols present | MATCH | None |
| Investment Intelligence | `ii_insights` | table | 11 cols, RLS on | 11 cols present | MATCH | None |
| Investment Intelligence | `ii_instrument_benchmarks` | table | 10 cols, RLS on | 10 cols present | MATCH | None |
| Investment Intelligence | `ii_instrument_identifiers` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Investment Intelligence | `ii_instruments` | table | 15 cols, RLS on | 15 cols present | MATCH | None |
| Investment Intelligence | `ii_portfolio_truth_status` | table | 27 cols, RLS on | 27 cols present | MATCH | None |
| Investment Intelligence | `ii_prices_nav` | table | 10 cols, RLS on | 10 cols present | MATCH | None |
| Investment Intelligence | `ii_r5_analytics_results` | table | 22 cols, RLS on | 22 cols present | MATCH | None |
| Investment Intelligence | `ii_reconciliation_cases` | table | 15 cols, RLS on | 15 cols present | MATCH | None |
| Investment Intelligence | `ii_reconciliation_config` | table | 8 cols, RLS on | 8 cols present | MATCH | None |
| Investment Intelligence | `ii_risk_free_rates` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Investment Intelligence | `ii_scheme_alias_map` | table | 11 cols, RLS on | 11 cols present | MATCH | None |
| Investment Intelligence | `ii_security_aliases` | table | 8 cols, RLS on | 8 cols present | MATCH | None |
| Investment Intelligence | `ii_security_classifications` | table | 14 cols, RLS on | 14 cols present | MATCH | None |
| Investment Intelligence | `ii_sip_series` | table | 17 cols, RLS on | 17 cols present | MATCH | None |
| Investment Intelligence | `ii_source_documents` | table | 27 cols, RLS on | 27 cols present | MATCH | None |
| Investment Intelligence | `ii_sources` | table | 11 cols, RLS on | 11 cols present | MATCH | None |
| Investment Intelligence | `ii_tax_lots` | table | 12 cols, RLS on | 12 cols present | MATCH | None |
| Investment Intelligence | `ii_tax_rule_versions` | table | 8 cols, RLS on | 8 cols present | MATCH | None |
| Investment Intelligence | `ii_transaction_source_links` | table | 7 cols, RLS on | 7 cols present | MATCH | None |
| Investment Intelligence | `ii_transactions` | table | 23 cols, RLS on | 23 cols present | MATCH | None |
| Resources / Phase 0C | `resource_audit_log` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Resources / Phase 0C | `resource_authors` | table | 11 cols, RLS on | 11 cols present | MATCH | None |
| Resources / Phase 0C | `resource_categories` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Resources / Phase 0C | `resource_context_links` | table | 10 cols, RLS on | 10 cols present | MATCH | None |
| Resources / Phase 0C | `resource_ctas` | table | 9 cols, RLS on | 9 cols present | MATCH | None |
| Resources / Phase 0C | `resource_faqs` | table | 12 cols, RLS on | 12 cols present | MATCH | None |
| Resources / Phase 0C | `resource_media` | table | 14 cols, RLS on | 14 cols present | MATCH | None |
| Resources / Phase 0C | `resource_post_categories` | table | 4 cols, RLS on | 4 cols present | MATCH | None |
| Resources / Phase 0C | `resource_post_faqs` | table | 3 cols, RLS on | 3 cols present | MATCH | None |
| Resources / Phase 0C | `resource_post_sources` | table | 4 cols, RLS on | 4 cols present | MATCH | None |
| Resources / Phase 0C | `resource_post_tags` | table | 2 cols, RLS on | 2 cols present | MATCH | None |
| Resources / Phase 0C | `resource_post_versions` | table | 7 cols, RLS on | 7 cols present | MATCH | None |
| Resources / Phase 0C | `resource_posts` | table | 44 cols, RLS on | 44 cols present | MATCH | None |
| Resources / Phase 0C | `resource_related_content` | table | 6 cols, RLS on | 6 cols present | MATCH | None |
| Resources / Phase 0C | `resource_settings` | table | 5 cols, RLS on | 5 cols present | MATCH | None |
| Resources / Phase 0C | `resource_sources` | table | 12 cols, RLS on | 12 cols present | MATCH | None |
| Resources / Phase 0C | `resource_tags` | table | 7 cols, RLS on | 7 cols present | MATCH | None |
| Resources / Phase 0C | `resource_user_roles` | table | 8 cols, RLS on | 8 cols present | MATCH | None |
| Resources / Phase 0C | `resource_videos` | table | 14 cols, RLS on | 14 cols present | MATCH | None |
| Resources / Phase 0C | `resource_workflow_history` | table | 11 cols, RLS on | 11 cols present | MATCH | None |
| Resources / Phase 0C | `user_financial_section_status` | table | 4 cols, RLS on | 4 cols present | MATCH | None |
