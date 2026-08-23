# Investment Intelligence — Expected Schema Manifest

> Generated from the certified clean rebuild of the active migration chain
> (`supabase/migrations/0001`-`0049`) into an empty PostgreSQL 18 database.
> This is the **intended** schema, reconstructed from migration definitions —
> not a dump of DEV, which is only ever used as the comparator.

Canonical owner of investment accounts, securities, holdings, investment transactions, valuations, portfolio calculations, performance data (XIRR/TWRR/CAGR), benchmarks, risk and investment analytics. Defined by active migrations 0031-0044.

## Summary

| Object type | Count |
|---|---|
| Tables | 33 |
| Columns | 471 |
| Constraints | 476 |
| Indexes | 115 |
| RLS policies | 33 |
| Tables with RLS enabled | 33 / 33 |

## Tables

| Table | Columns | RLS | Policies | Indexes | Constraints |
|---|---|---|---|---|---|
| `ii_accounts` | 13 | ENABLED | 1 | 3 | 15 |
| `ii_analytics_results` | 17 | ENABLED | 1 | 4 | 16 |
| `ii_analytics_results_r1_legacy` | 10 | ENABLED | 1 | 3 | 10 |
| `ii_audit_events` | 9 | ENABLED | 1 | 4 | 9 |
| `ii_benchmark_series` | 9 | ENABLED | 1 | 2 | 11 |
| `ii_benchmarks` | 9 | ENABLED | 1 | 2 | 10 |
| `ii_document_parse_runs` | 23 | ENABLED | 1 | 4 | 22 |
| `ii_fhip_publications` | 35 | ENABLED | 1 | 8 | 31 |
| `ii_fund_holdings` | 8 | ENABLED | 1 | 3 | 10 |
| `ii_fund_holdings_lines` | 23 | ENABLED | 1 | 3 | 15 |
| `ii_fund_holdings_snapshots` | 13 | ENABLED | 1 | 3 | 11 |
| `ii_goal_allocations` | 12 | ENABLED | 1 | 4 | 14 |
| `ii_holding_snapshots` | 16 | ENABLED | 1 | 5 | 18 |
| `ii_insights` | 11 | ENABLED | 1 | 2 | 15 |
| `ii_instrument_benchmarks` | 10 | ENABLED | 1 | 3 | 15 |
| `ii_instrument_identifiers` | 9 | ENABLED | 1 | 4 | 10 |
| `ii_instruments` | 15 | ENABLED | 1 | 3 | 16 |
| `ii_portfolio_truth_status` | 27 | ENABLED | 1 | 4 | 25 |
| `ii_prices_nav` | 10 | ENABLED | 1 | 2 | 13 |
| `ii_r5_analytics_results` | 22 | ENABLED | 1 | 4 | 16 |
| `ii_reconciliation_cases` | 15 | ENABLED | 1 | 4 | 16 |
| `ii_reconciliation_config` | 8 | ENABLED | 1 | 3 | 8 |
| `ii_risk_free_rates` | 9 | ENABLED | 1 | 3 | 13 |
| `ii_scheme_alias_map` | 11 | ENABLED | 1 | 3 | 9 |
| `ii_security_aliases` | 8 | ENABLED | 1 | 3 | 9 |
| `ii_security_classifications` | 14 | ENABLED | 1 | 3 | 11 |
| `ii_sip_series` | 17 | ENABLED | 1 | 3 | 20 |
| `ii_source_documents` | 27 | ENABLED | 1 | 4 | 19 |
| `ii_sources` | 11 | ENABLED | 1 | 2 | 10 |
| `ii_tax_lots` | 12 | ENABLED | 1 | 3 | 18 |
| `ii_tax_rule_versions` | 8 | ENABLED | 1 | 3 | 9 |
| `ii_transaction_source_links` | 7 | ENABLED | 1 | 5 | 12 |
| `ii_transactions` | 23 | ENABLED | 1 | 6 | 20 |

## Columns, constraints, indexes and policies (per table)

### `ii_accounts`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `owner_member_id` | uuid | YES | — |
| `country_code` | character | NO | — |
| `currency_code` | character | NO | — |
| `source_document_id` | uuid | YES | — |
| `status` | text | NO | `'active'::text` |
| `account_type` | text | NO | — |
| `institution_name` | text | NO | — |
| `account_number_masked` | text | YES | — |
| `folio_number` | text | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_accounts_account_type_check` | CHECK | `CHECK ((account_type = ANY (ARRAY['demat'::text, 'mf_folio'::text, 'broker'::text, 'retirement'::text, 'bank_linked'::text, 'other'::text])))` |
| `ii_accounts_account_type_not_null` | n | `NOT NULL account_type` |
| `ii_accounts_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_accounts_country_code_not_null` | n | `NOT NULL country_code` |
| `ii_accounts_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_accounts_currency_code_not_null` | n | `NOT NULL currency_code` |
| `ii_accounts_id_not_null` | n | `NOT NULL id` |
| `ii_accounts_institution_name_not_null` | n | `NOT NULL institution_name` |
| `ii_accounts_owner_member_id_fkey` | FOREIGN KEY | `FOREIGN KEY (owner_member_id) REFERENCES household_members(id)` |
| `ii_accounts_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_accounts_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id)` |
| `ii_accounts_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text, 'archived'::text])))` |
| `ii_accounts_status_not_null` | n | `NOT NULL status` |
| `ii_accounts_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_accounts_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_accounts_source_document` | `CREATE INDEX idx_ii_accounts_source_document ON public.ii_accounts USING btree (source_document_id) WHERE (source_document_id IS NOT NULL)` |
| `idx_ii_accounts_user` | `CREATE INDEX idx_ii_accounts_user ON public.ii_accounts USING btree (user_id)` |
| `ii_accounts_pkey` | `CREATE UNIQUE INDEX ii_accounts_pkey ON public.ii_accounts USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_accounts` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_analytics_results`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `scope_type` | text | NO | — |
| `scope_id` | text | NO | — |
| `metric_key` | text | NO | — |
| `metric_version` | text | NO | — |
| `engine_version` | text | NO | — |
| `data_as_of_date` | date | NO | — |
| `input_snapshot_version` | text | NO | — |
| `benchmark_mapping_version` | text | YES | — |
| `nav_data_version` | text | YES | — |
| `benchmark_data_version` | text | YES | — |
| `risk_free_version` | text | YES | — |
| `quality_status` | text | NO | — |
| `quality_reason` | text | YES | — |
| `result_value` | jsonb | NO | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_analytics_results_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_analytics_results_data_as_of_date_not_null` | n | `NOT NULL data_as_of_date` |
| `ii_analytics_results_engine_version_not_null` | n | `NOT NULL engine_version` |
| `ii_analytics_results_id_not_null1` | n | `NOT NULL id` |
| `ii_analytics_results_input_snapshot_version_not_null` | n | `NOT NULL input_snapshot_version` |
| `ii_analytics_results_metric_key_not_null1` | n | `NOT NULL metric_key` |
| `ii_analytics_results_metric_version_not_null` | n | `NOT NULL metric_version` |
| `ii_analytics_results_pkey1` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_analytics_results_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['ok'::text, 'unavailable'::text, 'stale'::text])))` |
| `ii_analytics_results_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_analytics_results_result_value_not_null` | n | `NOT NULL result_value` |
| `ii_analytics_results_scope_id_not_null` | n | `NOT NULL scope_id` |
| `ii_analytics_results_scope_type_check` | CHECK | `CHECK ((scope_type = ANY (ARRAY['scheme'::text, 'portfolio'::text])))` |
| `ii_analytics_results_scope_type_not_null` | n | `NOT NULL scope_type` |
| `ii_analytics_results_user_id_not_null1` | n | `NOT NULL user_id` |
| `ii_analytics_results_user_id_scope_type_scope_id_metric_key_key` | UNIQUE | `UNIQUE (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_analytics_results_created` | `CREATE INDEX idx_ii_analytics_results_created ON public.ii_analytics_results USING btree (created_at)` |
| `idx_ii_analytics_results_user_scope` | `CREATE INDEX idx_ii_analytics_results_user_scope ON public.ii_analytics_results USING btree (user_id, scope_type, scope_id, metric_key)` |
| `ii_analytics_results_pkey1` | `CREATE UNIQUE INDEX ii_analytics_results_pkey1 ON public.ii_analytics_results USING btree (id)` |
| `ii_analytics_results_user_id_scope_type_scope_id_metric_key_key` | `CREATE UNIQUE INDEX ii_analytics_results_user_id_scope_type_scope_id_metric_key_key ON public.ii_analytics_results USING btree (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read own ii_analytics_results` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `ii_analytics_results_r1_legacy`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `subject_type` | text | NO | — |
| `subject_id` | uuid | NO | — |
| `metric_key` | text | NO | — |
| `metric_value` | numeric | YES | — |
| `calculation_version` | text | NO | — |
| `calculated_at` | timestamp with time zone | NO | `now()` |
| `input_snapshot` | jsonb | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_analytics_results_calculated_at_not_null` | n | `NOT NULL calculated_at` |
| `ii_analytics_results_calculation_version_not_null` | n | `NOT NULL calculation_version` |
| `ii_analytics_results_id_not_null` | n | `NOT NULL id` |
| `ii_analytics_results_metric_key_not_null` | n | `NOT NULL metric_key` |
| `ii_analytics_results_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_analytics_results_subject_id_not_null` | n | `NOT NULL subject_id` |
| `ii_analytics_results_subject_type_check` | CHECK | `CHECK ((subject_type = ANY (ARRAY['position'::text, 'account'::text, 'portfolio'::text])))` |
| `ii_analytics_results_subject_type_not_null` | n | `NOT NULL subject_type` |
| `ii_analytics_results_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_analytics_results_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_analytics_results_r1_legacy_subject` | `CREATE INDEX idx_ii_analytics_results_r1_legacy_subject ON public.ii_analytics_results_r1_legacy USING btree (subject_type, subject_id)` |
| `idx_ii_analytics_results_r1_legacy_user` | `CREATE INDEX idx_ii_analytics_results_r1_legacy_user ON public.ii_analytics_results_r1_legacy USING btree (user_id)` |
| `ii_analytics_results_pkey` | `CREATE UNIQUE INDEX ii_analytics_results_pkey ON public.ii_analytics_results_r1_legacy USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read own ii_analytics_results_r1_legacy` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `ii_audit_events`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | YES | — |
| `event_type` | text | NO | — |
| `subject_type` | text | NO | — |
| `subject_id` | uuid | YES | — |
| `actor_type` | text | NO | — |
| `actor_id` | uuid | YES | — |
| `metadata` | jsonb | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_audit_events_actor_type_check` | CHECK | `CHECK ((actor_type = ANY (ARRAY['user'::text, 'admin'::text, 'system'::text, 'professional'::text])))` |
| `ii_audit_events_actor_type_not_null` | n | `NOT NULL actor_type` |
| `ii_audit_events_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_audit_events_event_type_check` | CHECK | `CHECK ((event_type = ANY (ARRAY['upload'::text, 'parse'::text, 'parse_completed'::text, 'reconciliation_opened'::text, 'reconciliation_resolved'::text, 'user_correction'::text, 'admin_correction'::text, 'publication'::text, 'republishing'::text, 'nav_price_update'::text, 'calculation'::text, 'rule_change'::text, 'goal_allocation'::text, 'export'::text, 'permission_grant'::text, 'permission_revoke'::text, 'professional_access'::text, 'archive'::text, 'deletion'::text, 'document_uploaded'::text, 'source_detected'::text, 'parse_started'::text, 'parse_failed'::text, 'parser_version_used'::text, 'account_resolved'::text, 'instrument_resolved'::text, 'reconciliation_case_created'::text, 'reconciliation_case_resolved'::text, 'portfolio_certified'::text, 'portfolio_certified_with_warnings'::text, 'portfolio_failed'::text, 'document_superseded'::text, 'document_processing_failed'::text, 'publication_previewed'::text, 'publication_created'::text, 'publication_confirmed'::text, 'manual_duplicate_linked'::text, 'manual_record_superseded'::text, 'publication_refreshed'::text, 'publication_superseded'::text, 'publication_unpublished'::text, 'publication_republished'::text, 'publication_failed'::text, 'conflict_detected'::text, 'conflict_resolved'::text])))` |
| `ii_audit_events_event_type_not_null` | n | `NOT NULL event_type` |
| `ii_audit_events_id_not_null` | n | `NOT NULL id` |
| `ii_audit_events_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_audit_events_subject_type_not_null` | n | `NOT NULL subject_type` |
| `ii_audit_events_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_audit_events_event_type` | `CREATE INDEX idx_ii_audit_events_event_type ON public.ii_audit_events USING btree (event_type, created_at DESC)` |
| `idx_ii_audit_events_subject` | `CREATE INDEX idx_ii_audit_events_subject ON public.ii_audit_events USING btree (subject_type, subject_id)` |
| `idx_ii_audit_events_user` | `CREATE INDEX idx_ii_audit_events_user ON public.ii_audit_events USING btree (user_id) WHERE (user_id IS NOT NULL)` |
| `ii_audit_events_pkey` | `CREATE UNIQUE INDEX ii_audit_events_pkey ON public.ii_audit_events USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read own ii_audit_events` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `ii_benchmark_series`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `benchmark_id` | uuid | NO | — |
| `series_date` | date | NO | — |
| `value` | numeric | NO | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `currency_code` | character | YES | — |
| `source_id` | uuid | YES | — |
| `data_version` | text | YES | — |
| `quality_status` | text | NO | `'ok'::text` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_benchmark_series_benchmark_id_fkey` | FOREIGN KEY | `FOREIGN KEY (benchmark_id) REFERENCES ii_benchmarks(id) ON DELETE CASCADE` |
| `ii_benchmark_series_benchmark_id_not_null` | n | `NOT NULL benchmark_id` |
| `ii_benchmark_series_benchmark_id_series_date_key` | UNIQUE | `UNIQUE (benchmark_id, series_date)` |
| `ii_benchmark_series_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_benchmark_series_id_not_null` | n | `NOT NULL id` |
| `ii_benchmark_series_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_benchmark_series_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['ok'::text, 'duplicate_flagged'::text, 'suspicious_jump'::text, 'stale'::text, 'superseded'::text])))` |
| `ii_benchmark_series_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_benchmark_series_series_date_not_null` | n | `NOT NULL series_date` |
| `ii_benchmark_series_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_benchmark_series_value_not_null` | n | `NOT NULL value` |

**Indexes**

| Name | Definition |
|---|---|
| `ii_benchmark_series_benchmark_id_series_date_key` | `CREATE UNIQUE INDEX ii_benchmark_series_benchmark_id_series_date_key ON public.ii_benchmark_series USING btree (benchmark_id, series_date)` |
| `ii_benchmark_series_pkey` | `CREATE UNIQUE INDEX ii_benchmark_series_pkey ON public.ii_benchmark_series USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_benchmark_series` | SELECT | {public} | `true` | `-` |

### `ii_benchmarks`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `benchmark_key` | text | NO | — |
| `benchmark_label` | text | NO | — |
| `benchmark_category` | text | NO | — |
| `country_code` | character | YES | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |
| `return_type` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_benchmarks_benchmark_category_check` | CHECK | `CHECK ((benchmark_category = ANY (ARRAY['index'::text, 'category_average'::text, 'custom'::text])))` |
| `ii_benchmarks_benchmark_category_not_null` | n | `NOT NULL benchmark_category` |
| `ii_benchmarks_benchmark_key_key` | UNIQUE | `UNIQUE (benchmark_key)` |
| `ii_benchmarks_benchmark_key_not_null` | n | `NOT NULL benchmark_key` |
| `ii_benchmarks_benchmark_label_not_null` | n | `NOT NULL benchmark_label` |
| `ii_benchmarks_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_benchmarks_id_not_null` | n | `NOT NULL id` |
| `ii_benchmarks_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_benchmarks_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_benchmarks_return_type_check` | CHECK | `CHECK ((return_type = ANY (ARRAY['TRI'::text, 'PRI'::text, 'DEBT_INDEX'::text, 'COMMODITY_GOLD'::text, 'OTHER'::text])))` |

**Indexes**

| Name | Definition |
|---|---|
| `ii_benchmarks_benchmark_key_key` | `CREATE UNIQUE INDEX ii_benchmarks_benchmark_key_key ON public.ii_benchmarks USING btree (benchmark_key)` |
| `ii_benchmarks_pkey` | `CREATE UNIQUE INDEX ii_benchmarks_pkey ON public.ii_benchmarks USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_benchmarks` | SELECT | {public} | `true` | `-` |

### `ii_document_parse_runs`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `source_document_id` | uuid | NO | — |
| `parser_code` | text | NO | — |
| `parser_version` | text | NO | — |
| `run_status` | text | NO | `'queued'::text` |
| `started_at` | timestamp with time zone | NO | `now()` |
| `completed_at` | timestamp with time zone | YES | — |
| `source_detected` | text | YES | — |
| `source_confidence` | numeric | YES | — |
| `document_type_detected` | text | YES | — |
| `format_version_detected` | text | YES | — |
| `extraction_method` | text | YES | — |
| `accounts_found` | integer | NO | `0` |
| `schemes_found` | integer | NO | `0` |
| `transactions_found` | integer | NO | `0` |
| `holdings_found` | integer | NO | `0` |
| `warnings` | jsonb | NO | `'[]'::jsonb` |
| `errors` | jsonb | NO | `'[]'::jsonb` |
| `password_required` | boolean | NO | `false` |
| `password_supplied` | boolean | NO | `false` |
| `idempotency_key` | text | NO | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_document_parse_runs_accounts_found_not_null` | n | `NOT NULL accounts_found` |
| `ii_document_parse_runs_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_document_parse_runs_errors_not_null` | n | `NOT NULL errors` |
| `ii_document_parse_runs_holdings_found_not_null` | n | `NOT NULL holdings_found` |
| `ii_document_parse_runs_id_not_null` | n | `NOT NULL id` |
| `ii_document_parse_runs_idempotency_key_not_null` | n | `NOT NULL idempotency_key` |
| `ii_document_parse_runs_parser_code_not_null` | n | `NOT NULL parser_code` |
| `ii_document_parse_runs_parser_version_not_null` | n | `NOT NULL parser_version` |
| `ii_document_parse_runs_password_required_not_null` | n | `NOT NULL password_required` |
| `ii_document_parse_runs_password_supplied_not_null` | n | `NOT NULL password_supplied` |
| `ii_document_parse_runs_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_document_parse_runs_run_status_check` | CHECK | `CHECK ((run_status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))` |
| `ii_document_parse_runs_run_status_not_null` | n | `NOT NULL run_status` |
| `ii_document_parse_runs_schemes_found_not_null` | n | `NOT NULL schemes_found` |
| `ii_document_parse_runs_source_confidence_check` | CHECK | `CHECK (((source_confidence IS NULL) OR ((source_confidence >= (0)::numeric) AND (source_confidence <= (1)::numeric))))` |
| `ii_document_parse_runs_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id) ON DELETE CASCADE` |
| `ii_document_parse_runs_source_document_id_not_null` | n | `NOT NULL source_document_id` |
| `ii_document_parse_runs_started_at_not_null` | n | `NOT NULL started_at` |
| `ii_document_parse_runs_transactions_found_not_null` | n | `NOT NULL transactions_found` |
| `ii_document_parse_runs_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_document_parse_runs_user_id_not_null` | n | `NOT NULL user_id` |
| `ii_document_parse_runs_warnings_not_null` | n | `NOT NULL warnings` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_document_parse_runs_document` | `CREATE INDEX idx_ii_document_parse_runs_document ON public.ii_document_parse_runs USING btree (source_document_id, started_at DESC)` |
| `idx_ii_document_parse_runs_user` | `CREATE INDEX idx_ii_document_parse_runs_user ON public.ii_document_parse_runs USING btree (user_id)` |
| `ii_document_parse_runs_pkey` | `CREATE UNIQUE INDEX ii_document_parse_runs_pkey ON public.ii_document_parse_runs USING btree (id)` |
| `uidx_ii_document_parse_runs_one_active` | `CREATE UNIQUE INDEX uidx_ii_document_parse_runs_one_active ON public.ii_document_parse_runs USING btree (source_document_id) WHERE (run_status = ANY (ARRAY['queued'::text, 'running'::text]))` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_document_parse_runs` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_fhip_publications`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `canonical_position_id` | uuid | NO | — |
| `publication_target` | text | NO | — |
| `published_row_id` | uuid | YES | — |
| `status` | text | NO | `'published'::text` |
| `include_in_net_worth` | boolean | NO | `true` |
| `published_at` | timestamp with time zone | NO | `now()` |
| `last_republished_at` | timestamp with time zone | YES | — |
| `account_id` | uuid | YES | — |
| `instrument_id` | uuid | YES | — |
| `owner_member_id` | uuid | YES | — |
| `published_owner` | text | YES | — |
| `source_currency` | character | YES | — |
| `source_country` | character | YES | — |
| `published_value` | numeric | YES | — |
| `published_cost_base` | numeric | YES | — |
| `cost_base_status` | text | NO | `'unknown'::text` |
| `published_annual_contribution` | numeric | YES | — |
| `annual_contribution_source` | text | NO | `'none'::text` |
| `risk_band` | text | NO | `'unknown'::text` |
| `target_master_item_key` | text | YES | — |
| `base_currency_code` | character | YES | — |
| `base_currency_amount` | numeric | YES | — |
| `base_currency_rate_used` | numeric | YES | — |
| `base_currency_computed_at` | timestamp with time zone | YES | — |
| `linkage_type` | text | NO | `'new_position'::text` |
| `linked_manual_investment_id` | uuid | YES | — |
| `supersedes_publication_id` | uuid | YES | — |
| `superseded_by_publication_id` | uuid | YES | — |
| `supersession_reason` | text | YES | — |
| `correlation_id` | uuid | YES | — |
| `idempotency_key` | text | YES | — |
| `failure_reason` | text | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_fhip_publications_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id)` |
| `ii_fhip_publications_annual_contribution_source_check` | CHECK | `CHECK ((annual_contribution_source = ANY (ARRAY['confirmed_user_plan'::text, 'none'::text])))` |
| `ii_fhip_publications_annual_contribution_source_not_null` | n | `NOT NULL annual_contribution_source` |
| `ii_fhip_publications_base_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (base_currency_code) REFERENCES currencies(currency_code)` |
| `ii_fhip_publications_canonical_position_id_fkey` | FOREIGN KEY | `FOREIGN KEY (canonical_position_id) REFERENCES ii_holding_snapshots(id)` |
| `ii_fhip_publications_canonical_position_id_key` | UNIQUE | `UNIQUE (canonical_position_id)` |
| `ii_fhip_publications_canonical_position_id_not_null` | n | `NOT NULL canonical_position_id` |
| `ii_fhip_publications_cost_base_status_check` | CHECK | `CHECK ((cost_base_status = ANY (ARRAY['certified'::text, 'partial'::text, 'unknown'::text, 'not_available'::text])))` |
| `ii_fhip_publications_cost_base_status_not_null` | n | `NOT NULL cost_base_status` |
| `ii_fhip_publications_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_fhip_publications_id_not_null` | n | `NOT NULL id` |
| `ii_fhip_publications_include_in_net_worth_not_null` | n | `NOT NULL include_in_net_worth` |
| `ii_fhip_publications_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_fhip_publications_linkage_type_check` | CHECK | `CHECK ((linkage_type = ANY (ARRAY['new_position'::text, 'linked_manual_row'::text])))` |
| `ii_fhip_publications_linkage_type_not_null` | n | `NOT NULL linkage_type` |
| `ii_fhip_publications_owner_member_id_fkey` | FOREIGN KEY | `FOREIGN KEY (owner_member_id) REFERENCES household_members(id)` |
| `ii_fhip_publications_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_fhip_publications_publication_target_check` | CHECK | `CHECK ((publication_target = ANY (ARRAY['assets'::text, 'investments'::text, 'retirement_accounts'::text])))` |
| `ii_fhip_publications_publication_target_not_null` | n | `NOT NULL publication_target` |
| `ii_fhip_publications_published_at_not_null` | n | `NOT NULL published_at` |
| `ii_fhip_publications_published_owner_check` | CHECK | `CHECK (((published_owner IS NULL) OR (published_owner = ANY (ARRAY['self'::text, 'spouse'::text, 'joint'::text, 'child'::text, 'family_trust'::text, 'company'::text, 'smsf'::text, 'other'::text]))))` |
| `ii_fhip_publications_risk_band_check` | CHECK | `CHECK ((risk_band = ANY (ARRAY['conservative'::text, 'balanced'::text, 'growth'::text, 'high_growth'::text, 'unknown'::text])))` |
| `ii_fhip_publications_risk_band_not_null` | n | `NOT NULL risk_band` |
| `ii_fhip_publications_source_country_fkey` | FOREIGN KEY | `FOREIGN KEY (source_country) REFERENCES countries(country_code)` |
| `ii_fhip_publications_source_currency_fkey` | FOREIGN KEY | `FOREIGN KEY (source_currency) REFERENCES currencies(currency_code)` |
| `ii_fhip_publications_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['published'::text, 'unpublished'::text, 'superseded'::text, 'failed'::text])))` |
| `ii_fhip_publications_status_not_null` | n | `NOT NULL status` |
| `ii_fhip_publications_superseded_by_publication_id_fkey` | FOREIGN KEY | `FOREIGN KEY (superseded_by_publication_id) REFERENCES ii_fhip_publications(id)` |
| `ii_fhip_publications_supersedes_publication_id_fkey` | FOREIGN KEY | `FOREIGN KEY (supersedes_publication_id) REFERENCES ii_fhip_publications(id)` |
| `ii_fhip_publications_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_fhip_publications_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_fhip_publications_correlation` | `CREATE INDEX idx_ii_fhip_publications_correlation ON public.ii_fhip_publications USING btree (correlation_id) WHERE (correlation_id IS NOT NULL)` |
| `idx_ii_fhip_publications_idempotency` | `CREATE INDEX idx_ii_fhip_publications_idempotency ON public.ii_fhip_publications USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)` |
| `idx_ii_fhip_publications_position` | `CREATE INDEX idx_ii_fhip_publications_position ON public.ii_fhip_publications USING btree (account_id, instrument_id)` |
| `idx_ii_fhip_publications_published_row` | `CREATE INDEX idx_ii_fhip_publications_published_row ON public.ii_fhip_publications USING btree (published_row_id) WHERE (published_row_id IS NOT NULL)` |
| `idx_ii_fhip_publications_user` | `CREATE INDEX idx_ii_fhip_publications_user ON public.ii_fhip_publications USING btree (user_id)` |
| `ii_fhip_publications_canonical_position_id_key` | `CREATE UNIQUE INDEX ii_fhip_publications_canonical_position_id_key ON public.ii_fhip_publications USING btree (canonical_position_id)` |
| `ii_fhip_publications_pkey` | `CREATE UNIQUE INDEX ii_fhip_publications_pkey ON public.ii_fhip_publications USING btree (id)` |
| `uidx_ii_fhip_publications_one_active_position` | `CREATE UNIQUE INDEX uidx_ii_fhip_publications_one_active_position ON public.ii_fhip_publications USING btree (account_id, instrument_id) WHERE (status = 'published'::text)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_fhip_publications` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_fund_holdings`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `fund_instrument_id` | uuid | NO | — |
| `underlying_instrument_id` | uuid | YES | — |
| `underlying_name` | text | YES | — |
| `disclosure_date` | date | NO | — |
| `weight_pct` | numeric | NO | — |
| `source_id` | uuid | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_fund_holdings_disclosure_date_not_null` | n | `NOT NULL disclosure_date` |
| `ii_fund_holdings_fund_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (fund_instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_fund_holdings_fund_instrument_id_not_null` | n | `NOT NULL fund_instrument_id` |
| `ii_fund_holdings_fund_instrument_id_underlying_instrument_i_key` | UNIQUE | `UNIQUE (fund_instrument_id, underlying_instrument_id, disclosure_date)` |
| `ii_fund_holdings_id_not_null` | n | `NOT NULL id` |
| `ii_fund_holdings_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_fund_holdings_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_fund_holdings_underlying_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (underlying_instrument_id) REFERENCES ii_instruments(id)` |
| `ii_fund_holdings_weight_pct_check` | CHECK | `CHECK (((weight_pct >= (0)::numeric) AND (weight_pct <= (100)::numeric)))` |
| `ii_fund_holdings_weight_pct_not_null` | n | `NOT NULL weight_pct` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_fund_holdings_fund` | `CREATE INDEX idx_ii_fund_holdings_fund ON public.ii_fund_holdings USING btree (fund_instrument_id)` |
| `ii_fund_holdings_fund_instrument_id_underlying_instrument_i_key` | `CREATE UNIQUE INDEX ii_fund_holdings_fund_instrument_id_underlying_instrument_i_key ON public.ii_fund_holdings USING btree (fund_instrument_id, underlying_instrument_id, disclosure_date)` |
| `ii_fund_holdings_pkey` | `CREATE UNIQUE INDEX ii_fund_holdings_pkey ON public.ii_fund_holdings USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_fund_holdings` | SELECT | {public} | `true` | `-` |

### `ii_fund_holdings_lines`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `snapshot_id` | uuid | NO | — |
| `underlying_instrument_id` | uuid | YES | — |
| `holding_name` | text | NO | — |
| `source_identifier` | text | YES | — |
| `isin` | text | YES | — |
| `issuer_id` | uuid | YES | — |
| `issuer_name` | text | YES | — |
| `asset_kind` | text | NO | `'security'::text` |
| `quantity` | numeric | YES | — |
| `market_value` | numeric | YES | — |
| `weight_pct` | numeric | NO | — |
| `sector_code` | text | YES | — |
| `industry_code` | text | YES | — |
| `market_cap_class` | text | YES | — |
| `security_type` | text | YES | — |
| `credit_rating_band` | text | YES | — |
| `agency_ratings` | jsonb | YES | — |
| `maturity_date` | date | YES | — |
| `coupon_pct` | numeric | YES | — |
| `modified_duration` | numeric | YES | — |
| `resolution_method` | text | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_fund_holdings_lines_asset_kind_check` | CHECK | `CHECK ((asset_kind = ANY (ARRAY['security'::text, 'cash'::text, 'derivative'::text, 'other'::text])))` |
| `ii_fund_holdings_lines_asset_kind_not_null` | n | `NOT NULL asset_kind` |
| `ii_fund_holdings_lines_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_fund_holdings_lines_credit_rating_band_check` | CHECK | `CHECK ((credit_rating_band = ANY (ARRAY['SOVEREIGN'::text, 'AAA'::text, 'AA'::text, 'A'::text, 'BELOW_A'::text, 'UNRATED'::text, 'OTHER_UNCLASSIFIED'::text])))` |
| `ii_fund_holdings_lines_holding_name_not_null` | n | `NOT NULL holding_name` |
| `ii_fund_holdings_lines_id_not_null` | n | `NOT NULL id` |
| `ii_fund_holdings_lines_issuer_id_fkey` | FOREIGN KEY | `FOREIGN KEY (issuer_id) REFERENCES ii_instruments(id)` |
| `ii_fund_holdings_lines_market_cap_class_check` | CHECK | `CHECK ((market_cap_class = ANY (ARRAY['LARGE'::text, 'MID'::text, 'SMALL'::text, 'OTHER'::text])))` |
| `ii_fund_holdings_lines_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_fund_holdings_lines_resolution_method_check` | CHECK | `CHECK ((resolution_method = ANY (ARRAY['ISIN'::text, 'EXCHANGE_ID'::text, 'PROVIDER_ID'::text, 'CONTROLLED_ALIAS'::text, 'EXACT_MAP'::text, 'UNRESOLVED'::text])))` |
| `ii_fund_holdings_lines_snapshot_id_fkey` | FOREIGN KEY | `FOREIGN KEY (snapshot_id) REFERENCES ii_fund_holdings_snapshots(id) ON DELETE CASCADE` |
| `ii_fund_holdings_lines_snapshot_id_not_null` | n | `NOT NULL snapshot_id` |
| `ii_fund_holdings_lines_underlying_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (underlying_instrument_id) REFERENCES ii_instruments(id)` |
| `ii_fund_holdings_lines_weight_pct_check` | CHECK | `CHECK (((weight_pct >= (0)::numeric) AND (weight_pct <= (100)::numeric)))` |
| `ii_fund_holdings_lines_weight_pct_not_null` | n | `NOT NULL weight_pct` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_fund_holdings_lines_snapshot` | `CREATE INDEX idx_ii_fund_holdings_lines_snapshot ON public.ii_fund_holdings_lines USING btree (snapshot_id)` |
| `idx_ii_fund_holdings_lines_underlying` | `CREATE INDEX idx_ii_fund_holdings_lines_underlying ON public.ii_fund_holdings_lines USING btree (underlying_instrument_id)` |
| `ii_fund_holdings_lines_pkey` | `CREATE UNIQUE INDEX ii_fund_holdings_lines_pkey ON public.ii_fund_holdings_lines USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_fund_holdings_lines` | SELECT | {public} | `true` | `-` |

### `ii_fund_holdings_snapshots`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `fund_instrument_id` | uuid | NO | — |
| `holdings_as_of_date` | date | NO | — |
| `ingested_at` | timestamp with time zone | NO | `now()` |
| `source_id` | uuid | YES | — |
| `source_document_version` | text | YES | — |
| `source_data_version` | text | YES | — |
| `classification_version` | text | YES | — |
| `disclosed_weight_total_pct` | numeric | YES | — |
| `quality_status` | text | NO | `'ok'::text` |
| `superseded_at` | timestamp with time zone | YES | — |
| `notes` | text | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_fund_holdings_snapshots_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_fund_holdings_snapshots_fund_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (fund_instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_fund_holdings_snapshots_fund_instrument_id_holdings_as_o_key` | UNIQUE | `UNIQUE (fund_instrument_id, holdings_as_of_date, source_document_version)` |
| `ii_fund_holdings_snapshots_fund_instrument_id_not_null` | n | `NOT NULL fund_instrument_id` |
| `ii_fund_holdings_snapshots_holdings_as_of_date_not_null` | n | `NOT NULL holdings_as_of_date` |
| `ii_fund_holdings_snapshots_id_not_null` | n | `NOT NULL id` |
| `ii_fund_holdings_snapshots_ingested_at_not_null` | n | `NOT NULL ingested_at` |
| `ii_fund_holdings_snapshots_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_fund_holdings_snapshots_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['ok'::text, 'partial_disclosure'::text, 'unverified_source'::text, 'superseded'::text])))` |
| `ii_fund_holdings_snapshots_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_fund_holdings_snapshots_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_fund_holdings_snapshots_fund_date` | `CREATE INDEX idx_ii_fund_holdings_snapshots_fund_date ON public.ii_fund_holdings_snapshots USING btree (fund_instrument_id, holdings_as_of_date DESC)` |
| `ii_fund_holdings_snapshots_fund_instrument_id_holdings_as_o_key` | `CREATE UNIQUE INDEX ii_fund_holdings_snapshots_fund_instrument_id_holdings_as_o_key ON public.ii_fund_holdings_snapshots USING btree (fund_instrument_id, holdings_as_of_date, source_document_version)` |
| `ii_fund_holdings_snapshots_pkey` | `CREATE UNIQUE INDEX ii_fund_holdings_snapshots_pkey ON public.ii_fund_holdings_snapshots USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_fund_holdings_snapshots` | SELECT | {public} | `true` | `-` |

### `ii_goal_allocations`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `investment_position_id` | uuid | NO | — |
| `goal_id` | uuid | NO | — |
| `allocation_type` | text | NO | — |
| `allocation_value` | numeric | YES | — |
| `source` | text | NO | — |
| `status` | text | NO | `'active'::text` |
| `effective_from` | date | NO | `CURRENT_DATE` |
| `effective_to` | date | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_goal_allocations_allocation_type_check` | CHECK | `CHECK ((allocation_type = ANY (ARRAY['percentage'::text, 'fixed_amount'::text, 'residual'::text])))` |
| `ii_goal_allocations_allocation_type_not_null` | n | `NOT NULL allocation_type` |
| `ii_goal_allocations_effective_from_not_null` | n | `NOT NULL effective_from` |
| `ii_goal_allocations_goal_id_fkey` | FOREIGN KEY | `FOREIGN KEY (goal_id) REFERENCES user_goals(id) ON DELETE CASCADE` |
| `ii_goal_allocations_goal_id_not_null` | n | `NOT NULL goal_id` |
| `ii_goal_allocations_id_not_null` | n | `NOT NULL id` |
| `ii_goal_allocations_investment_position_id_not_null` | n | `NOT NULL investment_position_id` |
| `ii_goal_allocations_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_goal_allocations_source_check` | CHECK | `CHECK ((source = ANY (ARRAY['user'::text, 'system_suggested'::text])))` |
| `ii_goal_allocations_source_not_null` | n | `NOT NULL source` |
| `ii_goal_allocations_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'removed'::text])))` |
| `ii_goal_allocations_status_not_null` | n | `NOT NULL status` |
| `ii_goal_allocations_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_goal_allocations_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_goal_allocations_goal` | `CREATE INDEX idx_ii_goal_allocations_goal ON public.ii_goal_allocations USING btree (goal_id)` |
| `idx_ii_goal_allocations_position` | `CREATE INDEX idx_ii_goal_allocations_position ON public.ii_goal_allocations USING btree (investment_position_id)` |
| `idx_ii_goal_allocations_user` | `CREATE INDEX idx_ii_goal_allocations_user ON public.ii_goal_allocations USING btree (user_id)` |
| `ii_goal_allocations_pkey` | `CREATE UNIQUE INDEX ii_goal_allocations_pkey ON public.ii_goal_allocations USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_goal_allocations` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_holding_snapshots`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `account_id` | uuid | NO | — |
| `instrument_id` | uuid | NO | — |
| `source_document_id` | uuid | YES | — |
| `currency_code` | character | NO | — |
| `quality_status` | text | NO | `'warning'::text` |
| `as_of_date` | date | NO | — |
| `units` | numeric | NO | — |
| `value` | numeric | NO | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `parse_run_id` | uuid | YES | — |
| `parser_code` | text | YES | — |
| `parser_version_used` | text | YES | — |
| `source_nav` | numeric | YES | — |
| `history_completeness` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_holding_snapshots_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id) ON DELETE CASCADE` |
| `ii_holding_snapshots_account_id_not_null` | n | `NOT NULL account_id` |
| `ii_holding_snapshots_as_of_date_not_null` | n | `NOT NULL as_of_date` |
| `ii_holding_snapshots_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_holding_snapshots_currency_code_not_null` | n | `NOT NULL currency_code` |
| `ii_holding_snapshots_history_completeness_check` | CHECK | `CHECK (((history_completeness IS NULL) OR (history_completeness = ANY (ARRAY['complete_from_inception'::text, 'complete_from_known_opening_balance'::text, 'partial_history'::text, 'holdings_only'::text]))))` |
| `ii_holding_snapshots_id_not_null` | n | `NOT NULL id` |
| `ii_holding_snapshots_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_holding_snapshots_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_holding_snapshots_parse_run_id_fkey` | FOREIGN KEY | `FOREIGN KEY (parse_run_id) REFERENCES ii_document_parse_runs(id)` |
| `ii_holding_snapshots_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_holding_snapshots_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['certified'::text, 'warning'::text, 'incomplete'::text])))` |
| `ii_holding_snapshots_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_holding_snapshots_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id)` |
| `ii_holding_snapshots_units_not_null` | n | `NOT NULL units` |
| `ii_holding_snapshots_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_holding_snapshots_user_id_not_null` | n | `NOT NULL user_id` |
| `ii_holding_snapshots_value_not_null` | n | `NOT NULL value` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_holding_snapshots_account_instrument_date` | `CREATE INDEX idx_ii_holding_snapshots_account_instrument_date ON public.ii_holding_snapshots USING btree (account_id, instrument_id, as_of_date DESC)` |
| `idx_ii_holding_snapshots_parse_run` | `CREATE INDEX idx_ii_holding_snapshots_parse_run ON public.ii_holding_snapshots USING btree (parse_run_id) WHERE (parse_run_id IS NOT NULL)` |
| `idx_ii_holding_snapshots_user` | `CREATE INDEX idx_ii_holding_snapshots_user ON public.ii_holding_snapshots USING btree (user_id)` |
| `ii_holding_snapshots_pkey` | `CREATE UNIQUE INDEX ii_holding_snapshots_pkey ON public.ii_holding_snapshots USING btree (id)` |
| `uidx_ii_holding_snapshots_position_date` | `CREATE UNIQUE INDEX uidx_ii_holding_snapshots_position_date ON public.ii_holding_snapshots USING btree (account_id, instrument_id, as_of_date)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_holding_snapshots` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_insights`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `classification` | text | NO | — |
| `rule_code` | text | NO | — |
| `rule_version` | text | NO | — |
| `severity` | text | NO | — |
| `evidence` | jsonb | YES | — |
| `status` | text | NO | `'active'::text` |
| `gated` | boolean | NO | `true` |
| `compliance_approved_at` | timestamp with time zone | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_ii_insights_advice_gated` | CHECK | `CHECK (((classification <> 'personalised_advice'::text) OR (gated = true)))` |
| `ii_insights_classification_check` | CHECK | `CHECK ((classification = ANY (ARRAY['observation'::text, 'education'::text, 'simulation'::text, 'personalised_advice'::text])))` |
| `ii_insights_classification_not_null` | n | `NOT NULL classification` |
| `ii_insights_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_insights_gated_not_null` | n | `NOT NULL gated` |
| `ii_insights_id_not_null` | n | `NOT NULL id` |
| `ii_insights_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_insights_rule_code_not_null` | n | `NOT NULL rule_code` |
| `ii_insights_rule_version_not_null` | n | `NOT NULL rule_version` |
| `ii_insights_severity_check` | CHECK | `CHECK ((severity = ANY (ARRAY['info'::text, 'low'::text, 'medium'::text, 'high'::text])))` |
| `ii_insights_severity_not_null` | n | `NOT NULL severity` |
| `ii_insights_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['active'::text, 'dismissed'::text, 'superseded'::text, 'expired'::text])))` |
| `ii_insights_status_not_null` | n | `NOT NULL status` |
| `ii_insights_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_insights_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_insights_user` | `CREATE INDEX idx_ii_insights_user ON public.ii_insights USING btree (user_id, status)` |
| `ii_insights_pkey` | `CREATE UNIQUE INDEX ii_insights_pkey ON public.ii_insights USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_insights` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_instrument_benchmarks`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_id` | uuid | NO | — |
| `benchmark_id` | uuid | NO | — |
| `relationship_type` | text | NO | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `effective_from` | date | NO | `'1900-01-01'::date` |
| `effective_to` | date | YES | — |
| `source_id` | uuid | YES | — |
| `mapping_version` | text | NO | `'v1'::text` |
| `quality_status` | text | NO | `'ok'::text` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_instrument_benchmarks_benchmark_id_fkey` | FOREIGN KEY | `FOREIGN KEY (benchmark_id) REFERENCES ii_benchmarks(id) ON DELETE CASCADE` |
| `ii_instrument_benchmarks_benchmark_id_not_null` | n | `NOT NULL benchmark_id` |
| `ii_instrument_benchmarks_effective_from_not_null` | n | `NOT NULL effective_from` |
| `ii_instrument_benchmarks_effective_range_check` | CHECK | `CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))` |
| `ii_instrument_benchmarks_id_not_null` | n | `NOT NULL id` |
| `ii_instrument_benchmarks_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_instrument_benchmarks_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_instrument_benchmarks_mapping_version_not_null` | n | `NOT NULL mapping_version` |
| `ii_instrument_benchmarks_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_instrument_benchmarks_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['ok'::text, 'ambiguous'::text, 'superseded'::text])))` |
| `ii_instrument_benchmarks_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_instrument_benchmarks_relationship_type_check` | CHECK | `CHECK ((relationship_type = ANY (ARRAY['primary'::text, 'secondary'::text, 'category_average'::text])))` |
| `ii_instrument_benchmarks_relationship_type_not_null` | n | `NOT NULL relationship_type` |
| `ii_instrument_benchmarks_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_instrument_benchmarks_unique_mapping_period` | UNIQUE | `UNIQUE (instrument_id, benchmark_id, relationship_type, effective_from)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_instrument_benchmarks_effective` | `CREATE INDEX idx_ii_instrument_benchmarks_effective ON public.ii_instrument_benchmarks USING btree (instrument_id, relationship_type, effective_from)` |
| `ii_instrument_benchmarks_pkey` | `CREATE UNIQUE INDEX ii_instrument_benchmarks_pkey ON public.ii_instrument_benchmarks USING btree (id)` |
| `ii_instrument_benchmarks_unique_mapping_period` | `CREATE UNIQUE INDEX ii_instrument_benchmarks_unique_mapping_period ON public.ii_instrument_benchmarks USING btree (instrument_id, benchmark_id, relationship_type, effective_from)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_instrument_benchmarks` | SELECT | {public} | `true` | `-` |

### `ii_instrument_identifiers`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_id` | uuid | NO | — |
| `identifier_scheme` | text | NO | — |
| `identifier_value` | text | NO | — |
| `country_code` | character | YES | — |
| `effective_from` | date | YES | — |
| `effective_to` | date | YES | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_ii_instrument_identifiers_country_scope` | CHECK | `CHECK (((identifier_scheme <> ALL (ARRAY['amfi_scheme_code'::text, 'nse_symbol'::text, 'bse_code'::text, 'internal_provisional'::text])) OR (country_code IS NOT NULL)))` |
| `ii_instrument_identifiers_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_instrument_identifiers_id_not_null` | n | `NOT NULL id` |
| `ii_instrument_identifiers_identifier_scheme_check` | CHECK | `CHECK ((identifier_scheme = ANY (ARRAY['isin'::text, 'amfi_scheme_code'::text, 'nse_symbol'::text, 'bse_code'::text, 'sedol'::text, 'internal_provisional'::text])))` |
| `ii_instrument_identifiers_identifier_scheme_not_null` | n | `NOT NULL identifier_scheme` |
| `ii_instrument_identifiers_identifier_value_not_null` | n | `NOT NULL identifier_value` |
| `ii_instrument_identifiers_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_instrument_identifiers_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_instrument_identifiers_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_instrument_identifiers_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_instrument_identifiers_instrument` | `CREATE INDEX idx_ii_instrument_identifiers_instrument ON public.ii_instrument_identifiers USING btree (instrument_id)` |
| `ii_instrument_identifiers_pkey` | `CREATE UNIQUE INDEX ii_instrument_identifiers_pkey ON public.ii_instrument_identifiers USING btree (id)` |
| `uidx_ii_instrument_identifiers_country_scoped` | `CREATE UNIQUE INDEX uidx_ii_instrument_identifiers_country_scoped ON public.ii_instrument_identifiers USING btree (identifier_scheme, identifier_value, country_code) WHERE (identifier_scheme = ANY (ARRAY['amfi_scheme_code'::text, 'nse_symbol'::text, 'bse_code'::text, 'internal_provisional'::text]))` |
| `uidx_ii_instrument_identifiers_global` | `CREATE UNIQUE INDEX uidx_ii_instrument_identifiers_global ON public.ii_instrument_identifiers USING btree (identifier_scheme, identifier_value) WHERE (identifier_scheme = ANY (ARRAY['isin'::text, 'sedol'::text]))` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_instrument_identifiers` | SELECT | {public} | `true` | `-` |

### `ii_instruments`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_name` | text | NO | — |
| `instrument_class` | text | NO | — |
| `country_of_domicile` | character | NO | — |
| `base_currency` | character | NO | — |
| `isin` | text | YES | — |
| `status` | text | NO | `'provisional'::text` |
| `merged_into_instrument_id` | uuid | YES | — |
| `source_id` | uuid | YES | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |
| `plan_type` | text | YES | — |
| `option_type` | text | YES | — |
| `amc_name` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_instruments_base_currency_fkey` | FOREIGN KEY | `FOREIGN KEY (base_currency) REFERENCES currencies(currency_code)` |
| `ii_instruments_base_currency_not_null` | n | `NOT NULL base_currency` |
| `ii_instruments_country_of_domicile_fkey` | FOREIGN KEY | `FOREIGN KEY (country_of_domicile) REFERENCES countries(country_code)` |
| `ii_instruments_country_of_domicile_not_null` | n | `NOT NULL country_of_domicile` |
| `ii_instruments_id_not_null` | n | `NOT NULL id` |
| `ii_instruments_instrument_class_check` | CHECK | `CHECK ((instrument_class = ANY (ARRAY['equity'::text, 'mutual_fund'::text, 'etf'::text, 'bond'::text, 'fixed_deposit'::text, 'gold'::text, 'crypto'::text, 'cash'::text, 'other'::text])))` |
| `ii_instruments_instrument_class_not_null` | n | `NOT NULL instrument_class` |
| `ii_instruments_instrument_name_not_null` | n | `NOT NULL instrument_name` |
| `ii_instruments_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_instruments_merged_into_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (merged_into_instrument_id) REFERENCES ii_instruments(id)` |
| `ii_instruments_option_type_check` | CHECK | `CHECK (((option_type IS NULL) OR (option_type = ANY (ARRAY['growth'::text, 'idcw'::text, 'dividend_payout'::text, 'dividend_reinvestment'::text, 'not_applicable'::text]))))` |
| `ii_instruments_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_instruments_plan_type_check` | CHECK | `CHECK (((plan_type IS NULL) OR (plan_type = ANY (ARRAY['direct'::text, 'regular'::text, 'not_applicable'::text]))))` |
| `ii_instruments_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_instruments_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['provisional'::text, 'verified'::text, 'deprecated'::text, 'merged'::text])))` |
| `ii_instruments_status_not_null` | n | `NOT NULL status` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_instruments_amc` | `CREATE INDEX idx_ii_instruments_amc ON public.ii_instruments USING btree (amc_name) WHERE (amc_name IS NOT NULL)` |
| `idx_ii_instruments_class` | `CREATE INDEX idx_ii_instruments_class ON public.ii_instruments USING btree (instrument_class)` |
| `ii_instruments_pkey` | `CREATE UNIQUE INDEX ii_instruments_pkey ON public.ii_instruments USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_instruments` | SELECT | {public} | `true` | `-` |

### `ii_portfolio_truth_status`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `account_id` | uuid | NO | — |
| `instrument_id` | uuid | NO | — |
| `status` | text | NO | `'pending'::text` |
| `history_completeness` | text | YES | — |
| `latest_holding_snapshot_id` | uuid | YES | — |
| `latest_source_document_id` | uuid | YES | — |
| `reconciled_opening_units` | numeric | YES | — |
| `reconciled_closing_units` | numeric | YES | — |
| `statement_closing_units` | numeric | YES | — |
| `unit_variance` | numeric | YES | — |
| `unit_variance_within_tolerance` | boolean | YES | — |
| `source_confidence` | numeric | YES | — |
| `parser_confidence` | numeric | YES | — |
| `owner_mapping_confidence` | numeric | YES | — |
| `instrument_mapping_confidence` | numeric | YES | — |
| `transaction_completeness_status` | text | YES | — |
| `holdings_reconciliation_status` | text | YES | — |
| `statement_freshness_days` | integer | YES | — |
| `blocking_reasons` | jsonb | NO | `'[]'::jsonb` |
| `warning_reasons` | jsonb | NO | `'[]'::jsonb` |
| `certified_at` | timestamp with time zone | YES | — |
| `certified_by` | uuid | YES | — |
| `last_evaluated_at` | timestamp with time zone | NO | `now()` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_portfolio_truth_status_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id) ON DELETE CASCADE` |
| `ii_portfolio_truth_status_account_id_instrument_id_key` | UNIQUE | `UNIQUE (account_id, instrument_id)` |
| `ii_portfolio_truth_status_account_id_not_null` | n | `NOT NULL account_id` |
| `ii_portfolio_truth_status_blocking_reasons_not_null` | n | `NOT NULL blocking_reasons` |
| `ii_portfolio_truth_status_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_portfolio_truth_status_history_completeness_check` | CHECK | `CHECK (((history_completeness IS NULL) OR (history_completeness = ANY (ARRAY['complete_from_inception'::text, 'complete_from_known_opening_balance'::text, 'partial_history'::text, 'holdings_only'::text]))))` |
| `ii_portfolio_truth_status_holdings_reconciliation_status_check` | CHECK | `CHECK (((holdings_reconciliation_status IS NULL) OR (holdings_reconciliation_status = ANY (ARRAY['matched'::text, 'material_mismatch'::text, 'within_tolerance'::text, 'not_evaluated'::text]))))` |
| `ii_portfolio_truth_status_id_not_null` | n | `NOT NULL id` |
| `ii_portfolio_truth_status_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_portfolio_truth_status_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_portfolio_truth_status_instrument_mapping_confidence_check` | CHECK | `CHECK (((instrument_mapping_confidence IS NULL) OR ((instrument_mapping_confidence >= (0)::numeric) AND (instrument_mapping_confidence <= (1)::numeric))))` |
| `ii_portfolio_truth_status_last_evaluated_at_not_null` | n | `NOT NULL last_evaluated_at` |
| `ii_portfolio_truth_status_latest_holding_snapshot_id_fkey` | FOREIGN KEY | `FOREIGN KEY (latest_holding_snapshot_id) REFERENCES ii_holding_snapshots(id)` |
| `ii_portfolio_truth_status_latest_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (latest_source_document_id) REFERENCES ii_source_documents(id)` |
| `ii_portfolio_truth_status_owner_mapping_confidence_check` | CHECK | `CHECK (((owner_mapping_confidence IS NULL) OR ((owner_mapping_confidence >= (0)::numeric) AND (owner_mapping_confidence <= (1)::numeric))))` |
| `ii_portfolio_truth_status_parser_confidence_check` | CHECK | `CHECK (((parser_confidence IS NULL) OR ((parser_confidence >= (0)::numeric) AND (parser_confidence <= (1)::numeric))))` |
| `ii_portfolio_truth_status_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_portfolio_truth_status_source_confidence_check` | CHECK | `CHECK (((source_confidence IS NULL) OR ((source_confidence >= (0)::numeric) AND (source_confidence <= (1)::numeric))))` |
| `ii_portfolio_truth_status_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['pending'::text, 'parsed'::text, 'reconciliation_required'::text, 'certified_with_warnings'::text, 'certified'::text, 'failed'::text, 'superseded'::text, 'archived'::text])))` |
| `ii_portfolio_truth_status_status_not_null` | n | `NOT NULL status` |
| `ii_portfolio_truth_status_transaction_completeness_status_check` | CHECK | `CHECK (((transaction_completeness_status IS NULL) OR (transaction_completeness_status = ANY (ARRAY['complete'::text, 'partial'::text, 'unknown'::text]))))` |
| `ii_portfolio_truth_status_updated_at_not_null` | n | `NOT NULL updated_at` |
| `ii_portfolio_truth_status_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_portfolio_truth_status_user_id_not_null` | n | `NOT NULL user_id` |
| `ii_portfolio_truth_status_warning_reasons_not_null` | n | `NOT NULL warning_reasons` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_portfolio_truth_status_status` | `CREATE INDEX idx_ii_portfolio_truth_status_status ON public.ii_portfolio_truth_status USING btree (user_id, status)` |
| `idx_ii_portfolio_truth_status_user` | `CREATE INDEX idx_ii_portfolio_truth_status_user ON public.ii_portfolio_truth_status USING btree (user_id)` |
| `ii_portfolio_truth_status_account_id_instrument_id_key` | `CREATE UNIQUE INDEX ii_portfolio_truth_status_account_id_instrument_id_key ON public.ii_portfolio_truth_status USING btree (account_id, instrument_id)` |
| `ii_portfolio_truth_status_pkey` | `CREATE UNIQUE INDEX ii_portfolio_truth_status_pkey ON public.ii_portfolio_truth_status USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_portfolio_truth_status` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_prices_nav`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_id` | uuid | NO | — |
| `source_id` | uuid | YES | — |
| `currency_code` | character | NO | — |
| `price_date` | date | NO | — |
| `price` | numeric | NO | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `source_timestamp` | timestamp with time zone | YES | — |
| `data_version` | text | YES | — |
| `quality_status` | text | NO | `'ok'::text` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_prices_nav_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_prices_nav_currency_code_not_null` | n | `NOT NULL currency_code` |
| `ii_prices_nav_id_not_null` | n | `NOT NULL id` |
| `ii_prices_nav_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_prices_nav_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_prices_nav_instrument_id_price_date_key` | UNIQUE | `UNIQUE (instrument_id, price_date)` |
| `ii_prices_nav_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_prices_nav_price_check` | CHECK | `CHECK ((price >= (0)::numeric))` |
| `ii_prices_nav_price_date_not_null` | n | `NOT NULL price_date` |
| `ii_prices_nav_price_not_null` | n | `NOT NULL price` |
| `ii_prices_nav_quality_status_check` | CHECK | `CHECK ((quality_status = ANY (ARRAY['ok'::text, 'suspicious_jump'::text, 'stale'::text, 'superseded'::text])))` |
| `ii_prices_nav_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_prices_nav_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |

**Indexes**

| Name | Definition |
|---|---|
| `ii_prices_nav_instrument_id_price_date_key` | `CREATE UNIQUE INDEX ii_prices_nav_instrument_id_price_date_key ON public.ii_prices_nav USING btree (instrument_id, price_date)` |
| `ii_prices_nav_pkey` | `CREATE UNIQUE INDEX ii_prices_nav_pkey ON public.ii_prices_nav USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_prices_nav` | SELECT | {public} | `true` | `-` |

### `ii_r5_analytics_results`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `scope_type` | text | NO | — |
| `scope_id` | text | NO | — |
| `metric_key` | text | NO | — |
| `metric_version` | text | NO | — |
| `engine_version` | text | NO | — |
| `data_as_of_date` | date | NO | — |
| `portfolio_as_of_date` | date | YES | — |
| `holdings_as_of_date` | date | YES | — |
| `holdings_snapshot_ids` | ARRAY | YES | — |
| `holdings_source_versions` | ARRAY | YES | — |
| `classification_version` | text | YES | — |
| `benchmark_mapping_version` | text | YES | — |
| `benchmark_data_version` | text | YES | — |
| `nav_data_version` | text | YES | — |
| `input_snapshot_version` | text | NO | — |
| `coverage` | numeric | YES | — |
| `quality_status` | text | NO | — |
| `quality_reason` | text | YES | — |
| `result_value` | jsonb | NO | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_r5_analytics_results_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_r5_analytics_results_data_as_of_date_not_null` | n | `NOT NULL data_as_of_date` |
| `ii_r5_analytics_results_engine_version_not_null` | n | `NOT NULL engine_version` |
| `ii_r5_analytics_results_id_not_null` | n | `NOT NULL id` |
| `ii_r5_analytics_results_input_snapshot_version_not_null` | n | `NOT NULL input_snapshot_version` |
| `ii_r5_analytics_results_metric_key_not_null` | n | `NOT NULL metric_key` |
| `ii_r5_analytics_results_metric_version_not_null` | n | `NOT NULL metric_version` |
| `ii_r5_analytics_results_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_r5_analytics_results_quality_status_not_null` | n | `NOT NULL quality_status` |
| `ii_r5_analytics_results_result_value_not_null` | n | `NOT NULL result_value` |
| `ii_r5_analytics_results_scope_id_not_null` | n | `NOT NULL scope_id` |
| `ii_r5_analytics_results_scope_type_check` | CHECK | `CHECK ((scope_type = ANY (ARRAY['sip_series'::text, 'scheme'::text, 'fund_pair'::text, 'portfolio'::text])))` |
| `ii_r5_analytics_results_scope_type_not_null` | n | `NOT NULL scope_type` |
| `ii_r5_analytics_results_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_r5_analytics_results_user_id_not_null` | n | `NOT NULL user_id` |
| `ii_r5_analytics_results_user_id_scope_type_scope_id_metric__key` | UNIQUE | `UNIQUE (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_r5_analytics_results_created` | `CREATE INDEX idx_ii_r5_analytics_results_created ON public.ii_r5_analytics_results USING btree (created_at)` |
| `idx_ii_r5_analytics_results_user_scope` | `CREATE INDEX idx_ii_r5_analytics_results_user_scope ON public.ii_r5_analytics_results USING btree (user_id, scope_type, scope_id, metric_key)` |
| `ii_r5_analytics_results_pkey` | `CREATE UNIQUE INDEX ii_r5_analytics_results_pkey ON public.ii_r5_analytics_results USING btree (id)` |
| `ii_r5_analytics_results_user_id_scope_type_scope_id_metric__key` | `CREATE UNIQUE INDEX ii_r5_analytics_results_user_id_scope_type_scope_id_metric__key ON public.ii_r5_analytics_results USING btree (user_id, scope_type, scope_id, metric_key, input_snapshot_version, engine_version)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read own ii_r5_analytics_results` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `ii_reconciliation_cases`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `subject_type` | text | NO | — |
| `subject_id` | uuid | NO | — |
| `status` | text | NO | `'open'::text` |
| `discrepancy_type` | text | NO | — |
| `discrepancy_details` | jsonb | YES | — |
| `opened_at` | timestamp with time zone | NO | `now()` |
| `resolved_at` | timestamp with time zone | YES | — |
| `severity` | text | NO | `'medium'::text` |
| `source_document_id` | uuid | YES | — |
| `evidence` | jsonb | YES | — |
| `resolution_method` | text | YES | — |
| `resolved_by` | uuid | YES | — |
| `resolved_by_actor_type` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_reconciliation_cases_discrepancy_type_check` | CHECK | `CHECK ((discrepancy_type = ANY (ARRAY['owner_unmatched'::text, 'account_unmatched'::text, 'instrument_unmatched'::text, 'ambiguous_instrument'::text, 'transaction_unclassified'::text, 'unit_mismatch'::text, 'value_mismatch'::text, 'duplicate_suspected'::text, 'missing_opening_history'::text, 'unsupported_document'::text, 'document_corrupt'::text, 'document_password_required'::text, 'parse_incomplete'::text, 'statement_period_gap'::text, 'other'::text])))` |
| `ii_reconciliation_cases_discrepancy_type_not_null` | n | `NOT NULL discrepancy_type` |
| `ii_reconciliation_cases_id_not_null` | n | `NOT NULL id` |
| `ii_reconciliation_cases_opened_at_not_null` | n | `NOT NULL opened_at` |
| `ii_reconciliation_cases_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_reconciliation_cases_resolved_by_actor_type_check` | CHECK | `CHECK (((resolved_by_actor_type IS NULL) OR (resolved_by_actor_type = ANY (ARRAY['user'::text, 'admin'::text, 'system'::text]))))` |
| `ii_reconciliation_cases_severity_check` | CHECK | `CHECK ((severity = ANY (ARRAY['info'::text, 'low'::text, 'medium'::text, 'high'::text, 'blocking'::text])))` |
| `ii_reconciliation_cases_severity_not_null` | n | `NOT NULL severity` |
| `ii_reconciliation_cases_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id)` |
| `ii_reconciliation_cases_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['open'::text, 'user_reviewing'::text, 'resolved'::text, 'dismissed'::text])))` |
| `ii_reconciliation_cases_status_not_null` | n | `NOT NULL status` |
| `ii_reconciliation_cases_subject_id_not_null` | n | `NOT NULL subject_id` |
| `ii_reconciliation_cases_subject_type_check` | CHECK | `CHECK ((subject_type = ANY (ARRAY['holding_snapshot'::text, 'transaction'::text, 'account'::text])))` |
| `ii_reconciliation_cases_subject_type_not_null` | n | `NOT NULL subject_type` |
| `ii_reconciliation_cases_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_reconciliation_cases_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_reconciliation_cases_document` | `CREATE INDEX idx_ii_reconciliation_cases_document ON public.ii_reconciliation_cases USING btree (source_document_id) WHERE (source_document_id IS NOT NULL)` |
| `idx_ii_reconciliation_cases_severity` | `CREATE INDEX idx_ii_reconciliation_cases_severity ON public.ii_reconciliation_cases USING btree (user_id, severity, status)` |
| `idx_ii_reconciliation_cases_user` | `CREATE INDEX idx_ii_reconciliation_cases_user ON public.ii_reconciliation_cases USING btree (user_id, status)` |
| `ii_reconciliation_cases_pkey` | `CREATE UNIQUE INDEX ii_reconciliation_cases_pkey ON public.ii_reconciliation_cases USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_reconciliation_cases` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_reconciliation_config`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `config_version` | text | NO | — |
| `unit_tolerance` | numeric | NO | — |
| `currency_tolerance` | numeric | NO | — |
| `statement_freshness_warning_days` | integer | NO | — |
| `is_active` | boolean | NO | `false` |
| `notes` | text | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_reconciliation_config_config_version_key` | UNIQUE | `UNIQUE (config_version)` |
| `ii_reconciliation_config_config_version_not_null` | n | `NOT NULL config_version` |
| `ii_reconciliation_config_currency_tolerance_not_null` | n | `NOT NULL currency_tolerance` |
| `ii_reconciliation_config_id_not_null` | n | `NOT NULL id` |
| `ii_reconciliation_config_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_reconciliation_config_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_reconciliation_config_statement_freshness_warning_d_not_null` | n | `NOT NULL statement_freshness_warning_days` |
| `ii_reconciliation_config_unit_tolerance_not_null` | n | `NOT NULL unit_tolerance` |

**Indexes**

| Name | Definition |
|---|---|
| `ii_reconciliation_config_config_version_key` | `CREATE UNIQUE INDEX ii_reconciliation_config_config_version_key ON public.ii_reconciliation_config USING btree (config_version)` |
| `ii_reconciliation_config_pkey` | `CREATE UNIQUE INDEX ii_reconciliation_config_pkey ON public.ii_reconciliation_config USING btree (id)` |
| `uidx_ii_reconciliation_config_one_active` | `CREATE UNIQUE INDEX uidx_ii_reconciliation_config_one_active ON public.ii_reconciliation_config USING btree ((true)) WHERE (is_active = true)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_reconciliation_config` | SELECT | {public} | `true` | `-` |

### `ii_risk_free_rates`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `country_code` | character | NO | — |
| `period_start` | date | NO | — |
| `period_end` | date | NO | — |
| `annualised_rate` | numeric | NO | — |
| `source` | text | NO | — |
| `method` | text | NO | — |
| `version` | text | NO | `'v1'::text` |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_risk_free_rates_annualised_rate_not_null` | n | `NOT NULL annualised_rate` |
| `ii_risk_free_rates_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_risk_free_rates_country_code_not_null` | n | `NOT NULL country_code` |
| `ii_risk_free_rates_country_code_period_start_period_end_ver_key` | UNIQUE | `UNIQUE (country_code, period_start, period_end, version)` |
| `ii_risk_free_rates_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_risk_free_rates_id_not_null` | n | `NOT NULL id` |
| `ii_risk_free_rates_method_not_null` | n | `NOT NULL method` |
| `ii_risk_free_rates_period_check` | CHECK | `CHECK ((period_end >= period_start))` |
| `ii_risk_free_rates_period_end_not_null` | n | `NOT NULL period_end` |
| `ii_risk_free_rates_period_start_not_null` | n | `NOT NULL period_start` |
| `ii_risk_free_rates_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_risk_free_rates_source_not_null` | n | `NOT NULL source` |
| `ii_risk_free_rates_version_not_null` | n | `NOT NULL version` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_risk_free_rates_country_period` | `CREATE INDEX idx_ii_risk_free_rates_country_period ON public.ii_risk_free_rates USING btree (country_code, period_start, period_end)` |
| `ii_risk_free_rates_country_code_period_start_period_end_ver_key` | `CREATE UNIQUE INDEX ii_risk_free_rates_country_code_period_start_period_end_ver_key ON public.ii_risk_free_rates USING btree (country_code, period_start, period_end, version)` |
| `ii_risk_free_rates_pkey` | `CREATE UNIQUE INDEX ii_risk_free_rates_pkey ON public.ii_risk_free_rates USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_risk_free_rates` | SELECT | {public} | `true` | `-` |

### `ii_scheme_alias_map`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `raw_scheme_name_normalised` | text | NO | — |
| `amc_name` | text | YES | — |
| `plan_type` | text | YES | — |
| `option_type` | text | YES | — |
| `resolved_instrument_id` | uuid | NO | — |
| `country_code` | character | YES | — |
| `is_active` | boolean | NO | `true` |
| `notes` | text | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_scheme_alias_map_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_scheme_alias_map_id_not_null` | n | `NOT NULL id` |
| `ii_scheme_alias_map_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_scheme_alias_map_option_type_check` | CHECK | `CHECK (((option_type IS NULL) OR (option_type = ANY (ARRAY['growth'::text, 'idcw'::text, 'dividend_payout'::text, 'dividend_reinvestment'::text, 'not_applicable'::text]))))` |
| `ii_scheme_alias_map_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_scheme_alias_map_plan_type_check` | CHECK | `CHECK (((plan_type IS NULL) OR (plan_type = ANY (ARRAY['direct'::text, 'regular'::text, 'not_applicable'::text]))))` |
| `ii_scheme_alias_map_raw_scheme_name_normalised_not_null` | n | `NOT NULL raw_scheme_name_normalised` |
| `ii_scheme_alias_map_resolved_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (resolved_instrument_id) REFERENCES ii_instruments(id)` |
| `ii_scheme_alias_map_resolved_instrument_id_not_null` | n | `NOT NULL resolved_instrument_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_scheme_alias_map_instrument` | `CREATE INDEX idx_ii_scheme_alias_map_instrument ON public.ii_scheme_alias_map USING btree (resolved_instrument_id)` |
| `ii_scheme_alias_map_pkey` | `CREATE UNIQUE INDEX ii_scheme_alias_map_pkey ON public.ii_scheme_alias_map USING btree (id)` |
| `uidx_ii_scheme_alias_map_key` | `CREATE UNIQUE INDEX uidx_ii_scheme_alias_map_key ON public.ii_scheme_alias_map USING btree (raw_scheme_name_normalised, COALESCE(plan_type, ''::text), COALESCE(option_type, ''::text), COALESCE(country_code, ''::bpchar))` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_scheme_alias_map` | SELECT | {public} | `true` | `-` |

### `ii_security_aliases`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_id` | uuid | NO | — |
| `alias_normalised` | text | NO | — |
| `alias_raw` | text | NO | — |
| `source_id` | uuid | YES | — |
| `approved_by` | text | YES | — |
| `approved_at` | timestamp with time zone | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_security_aliases_alias_normalised_key` | UNIQUE | `UNIQUE (alias_normalised)` |
| `ii_security_aliases_alias_normalised_not_null` | n | `NOT NULL alias_normalised` |
| `ii_security_aliases_alias_raw_not_null` | n | `NOT NULL alias_raw` |
| `ii_security_aliases_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_security_aliases_id_not_null` | n | `NOT NULL id` |
| `ii_security_aliases_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_security_aliases_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_security_aliases_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_security_aliases_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_security_aliases_instrument` | `CREATE INDEX idx_ii_security_aliases_instrument ON public.ii_security_aliases USING btree (instrument_id)` |
| `ii_security_aliases_alias_normalised_key` | `CREATE UNIQUE INDEX ii_security_aliases_alias_normalised_key ON public.ii_security_aliases USING btree (alias_normalised)` |
| `ii_security_aliases_pkey` | `CREATE UNIQUE INDEX ii_security_aliases_pkey ON public.ii_security_aliases USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_security_aliases` | SELECT | {public} | `true` | `-` |

### `ii_security_classifications`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `instrument_id` | uuid | NO | — |
| `classification_version` | text | NO | — |
| `taxonomy_key` | text | NO | — |
| `sector_code` | text | YES | — |
| `sector_label` | text | YES | — |
| `industry_code` | text | YES | — |
| `industry_label` | text | YES | — |
| `market_cap_class` | text | YES | — |
| `market_cap_source` | text | YES | — |
| `effective_from` | date | NO | `'1900-01-01'::date` |
| `effective_to` | date | YES | — |
| `source_id` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_security_classifications_classification_version_not_null` | n | `NOT NULL classification_version` |
| `ii_security_classifications_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_security_classifications_effective_from_not_null` | n | `NOT NULL effective_from` |
| `ii_security_classifications_id_not_null` | n | `NOT NULL id` |
| `ii_security_classifications_instrument_id_classification_ve_key` | UNIQUE | `UNIQUE (instrument_id, classification_version, taxonomy_key, effective_from)` |
| `ii_security_classifications_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id) ON DELETE CASCADE` |
| `ii_security_classifications_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_security_classifications_market_cap_class_check` | CHECK | `CHECK ((market_cap_class = ANY (ARRAY['LARGE'::text, 'MID'::text, 'SMALL'::text, 'OTHER'::text])))` |
| `ii_security_classifications_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_security_classifications_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_security_classifications_taxonomy_key_not_null` | n | `NOT NULL taxonomy_key` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_security_classifications_instrument` | `CREATE INDEX idx_ii_security_classifications_instrument ON public.ii_security_classifications USING btree (instrument_id, effective_from DESC)` |
| `ii_security_classifications_instrument_id_classification_ve_key` | `CREATE UNIQUE INDEX ii_security_classifications_instrument_id_classification_ve_key ON public.ii_security_classifications USING btree (instrument_id, classification_version, taxonomy_key, effective_from)` |
| `ii_security_classifications_pkey` | `CREATE UNIQUE INDEX ii_security_classifications_pkey ON public.ii_security_classifications USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_security_classifications` | SELECT | {public} | `true` | `-` |

### `ii_sip_series`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `account_id` | uuid | NO | — |
| `instrument_id` | uuid | NO | — |
| `series_key` | text | NO | — |
| `cadence` | text | NO | — |
| `detection_confidence` | text | NO | — |
| `confidence_rationale` | text | YES | — |
| `contribution_trend` | text | YES | — |
| `first_contribution_date` | date | YES | — |
| `latest_contribution_date` | date | YES | — |
| `contribution_count` | integer | YES | — |
| `currency_code` | character | YES | — |
| `detection_method_version` | text | NO | — |
| `threshold_config_version` | text | NO | — |
| `computed_at` | timestamp with time zone | NO | `now()` |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_sip_series_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id) ON DELETE CASCADE` |
| `ii_sip_series_account_id_not_null` | n | `NOT NULL account_id` |
| `ii_sip_series_cadence_check` | CHECK | `CHECK ((cadence = ANY (ARRAY['MONTHLY'::text, 'QUARTERLY'::text, 'WEEKLY'::text, 'FORTNIGHTLY'::text, 'ANNUAL'::text, 'OTHER_RECURRING'::text, 'IRREGULAR'::text, 'UNKNOWN'::text])))` |
| `ii_sip_series_cadence_not_null` | n | `NOT NULL cadence` |
| `ii_sip_series_computed_at_not_null` | n | `NOT NULL computed_at` |
| `ii_sip_series_contribution_trend_check` | CHECK | `CHECK ((contribution_trend = ANY (ARRAY['FLAT'::text, 'INCREASING'::text, 'DECREASING'::text, 'MIXED'::text])))` |
| `ii_sip_series_created_at_not_null` | n | `NOT NULL created_at` |
| `ii_sip_series_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_sip_series_detection_confidence_check` | CHECK | `CHECK ((detection_confidence = ANY (ARRAY['CONFIRMED_SOURCE'::text, 'HIGH_CONFIDENCE'::text, 'POSSIBLE'::text, 'AMBIGUOUS'::text, 'NOT_SIP'::text])))` |
| `ii_sip_series_detection_confidence_not_null` | n | `NOT NULL detection_confidence` |
| `ii_sip_series_detection_method_version_not_null` | n | `NOT NULL detection_method_version` |
| `ii_sip_series_id_not_null` | n | `NOT NULL id` |
| `ii_sip_series_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_sip_series_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_sip_series_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_sip_series_series_key_not_null` | n | `NOT NULL series_key` |
| `ii_sip_series_threshold_config_version_not_null` | n | `NOT NULL threshold_config_version` |
| `ii_sip_series_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_sip_series_user_id_not_null` | n | `NOT NULL user_id` |
| `ii_sip_series_user_id_series_key_detection_method_version_t_key` | UNIQUE | `UNIQUE (user_id, series_key, detection_method_version, threshold_config_version)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_sip_series_user` | `CREATE INDEX idx_ii_sip_series_user ON public.ii_sip_series USING btree (user_id, instrument_id)` |
| `ii_sip_series_pkey` | `CREATE UNIQUE INDEX ii_sip_series_pkey ON public.ii_sip_series USING btree (id)` |
| `ii_sip_series_user_id_series_key_detection_method_version_t_key` | `CREATE UNIQUE INDEX ii_sip_series_user_id_series_key_detection_method_version_t_key ON public.ii_sip_series USING btree (user_id, series_key, detection_method_version, threshold_config_version)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read own ii_sip_series` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `ii_source_documents`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `owner_member_id` | uuid | YES | — |
| `country_code` | character | NO | — |
| `source_id` | uuid | YES | — |
| `status` | text | NO | `'uploaded'::text` |
| `checksum` | text | YES | — |
| `superseded_by_document_id` | uuid | YES | — |
| `storage_path` | text | NO | — |
| `original_filename` | text | NO | — |
| `mime_type` | text | NO | — |
| `file_size` | bigint | NO | — |
| `uploaded_at` | timestamp with time zone | NO | `now()` |
| `document_type` | text | YES | — |
| `statement_period_start` | date | YES | — |
| `statement_period_end` | date | YES | — |
| `statement_as_of_date` | date | YES | — |
| `parser_version` | text | YES | — |
| `parse_completed_at` | timestamp with time zone | YES | — |
| `parse_error` | text | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `updated_at` | timestamp with time zone | YES | `now()` |
| `source_detected` | text | YES | — |
| `source_confidence` | numeric | YES | — |
| `document_type_detected` | text | YES | — |
| `format_version_detected` | text | YES | — |
| `extraction_method` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_source_documents_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_source_documents_country_code_not_null` | n | `NOT NULL country_code` |
| `ii_source_documents_document_type_check` | CHECK | `CHECK ((document_type = ANY (ARRAY['cas_statement'::text, 'demat_statement'::text, 'contract_note'::text, 'manual_entry_record'::text, 'other'::text])))` |
| `ii_source_documents_file_size_check` | CHECK | `CHECK ((file_size >= 0))` |
| `ii_source_documents_file_size_not_null` | n | `NOT NULL file_size` |
| `ii_source_documents_id_not_null` | n | `NOT NULL id` |
| `ii_source_documents_mime_type_not_null` | n | `NOT NULL mime_type` |
| `ii_source_documents_original_filename_not_null` | n | `NOT NULL original_filename` |
| `ii_source_documents_owner_member_id_fkey` | FOREIGN KEY | `FOREIGN KEY (owner_member_id) REFERENCES household_members(id)` |
| `ii_source_documents_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_source_documents_source_confidence_check` | CHECK | `CHECK (((source_confidence IS NULL) OR ((source_confidence >= (0)::numeric) AND (source_confidence <= (1)::numeric))))` |
| `ii_source_documents_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES ii_sources(id)` |
| `ii_source_documents_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['uploaded'::text, 'parsing'::text, 'parsed'::text, 'parse_failed'::text, 'superseded'::text, 'archived'::text, 'password_required'::text, 'reconciliation_required'::text, 'unsupported'::text])))` |
| `ii_source_documents_status_not_null` | n | `NOT NULL status` |
| `ii_source_documents_storage_path_not_null` | n | `NOT NULL storage_path` |
| `ii_source_documents_superseded_by_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (superseded_by_document_id) REFERENCES ii_source_documents(id)` |
| `ii_source_documents_uploaded_at_not_null` | n | `NOT NULL uploaded_at` |
| `ii_source_documents_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_source_documents_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_source_documents_status` | `CREATE INDEX idx_ii_source_documents_status ON public.ii_source_documents USING btree (status)` |
| `idx_ii_source_documents_user` | `CREATE INDEX idx_ii_source_documents_user ON public.ii_source_documents USING btree (user_id)` |
| `ii_source_documents_pkey` | `CREATE UNIQUE INDEX ii_source_documents_pkey ON public.ii_source_documents USING btree (id)` |
| `uidx_ii_source_documents_user_checksum` | `CREATE UNIQUE INDEX uidx_ii_source_documents_user_checksum ON public.ii_source_documents USING btree (user_id, checksum) WHERE (checksum IS NOT NULL)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_source_documents` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_sources`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `source_key` | text | NO | — |
| `source_label` | text | NO | — |
| `source_category` | text | NO | — |
| `country_code` | character | YES | — |
| `is_active` | boolean | NO | `true` |
| `effective_from` | date | YES | — |
| `effective_to` | date | YES | — |
| `parser_available` | boolean | NO | `false` |
| `metadata` | jsonb | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_sources_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_sources_id_not_null` | n | `NOT NULL id` |
| `ii_sources_is_active_not_null` | n | `NOT NULL is_active` |
| `ii_sources_parser_available_not_null` | n | `NOT NULL parser_available` |
| `ii_sources_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_sources_source_category_check` | CHECK | `CHECK ((source_category = ANY (ARRAY['statement_provider'::text, 'broker'::text, 'manual'::text, 'admin'::text, 'api_connector'::text])))` |
| `ii_sources_source_category_not_null` | n | `NOT NULL source_category` |
| `ii_sources_source_key_key` | UNIQUE | `UNIQUE (source_key)` |
| `ii_sources_source_key_not_null` | n | `NOT NULL source_key` |
| `ii_sources_source_label_not_null` | n | `NOT NULL source_label` |

**Indexes**

| Name | Definition |
|---|---|
| `ii_sources_pkey` | `CREATE UNIQUE INDEX ii_sources_pkey ON public.ii_sources USING btree (id)` |
| `ii_sources_source_key_key` | `CREATE UNIQUE INDEX ii_sources_source_key_key ON public.ii_sources USING btree (source_key)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_sources` | SELECT | {public} | `true` | `-` |

### `ii_tax_lots`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `account_id` | uuid | NO | — |
| `instrument_id` | uuid | NO | — |
| `opening_transaction_id` | uuid | YES | — |
| `status` | text | NO | `'open'::text` |
| `acquisition_date` | date | NO | — |
| `units_acquired` | numeric | NO | — |
| `units_remaining` | numeric | NO | — |
| `cost_per_unit` | numeric | NO | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `closed_at` | timestamp with time zone | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_tax_lots_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id) ON DELETE CASCADE` |
| `ii_tax_lots_account_id_not_null` | n | `NOT NULL account_id` |
| `ii_tax_lots_acquisition_date_not_null` | n | `NOT NULL acquisition_date` |
| `ii_tax_lots_cost_per_unit_check` | CHECK | `CHECK ((cost_per_unit >= (0)::numeric))` |
| `ii_tax_lots_cost_per_unit_not_null` | n | `NOT NULL cost_per_unit` |
| `ii_tax_lots_id_not_null` | n | `NOT NULL id` |
| `ii_tax_lots_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_tax_lots_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_tax_lots_opening_transaction_id_fkey` | FOREIGN KEY | `FOREIGN KEY (opening_transaction_id) REFERENCES ii_transactions(id)` |
| `ii_tax_lots_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_tax_lots_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['open'::text, 'partially_closed'::text, 'closed'::text])))` |
| `ii_tax_lots_status_not_null` | n | `NOT NULL status` |
| `ii_tax_lots_units_acquired_check` | CHECK | `CHECK ((units_acquired >= (0)::numeric))` |
| `ii_tax_lots_units_acquired_not_null` | n | `NOT NULL units_acquired` |
| `ii_tax_lots_units_remaining_check` | CHECK | `CHECK ((units_remaining >= (0)::numeric))` |
| `ii_tax_lots_units_remaining_not_null` | n | `NOT NULL units_remaining` |
| `ii_tax_lots_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_tax_lots_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_tax_lots_account_instrument` | `CREATE INDEX idx_ii_tax_lots_account_instrument ON public.ii_tax_lots USING btree (account_id, instrument_id)` |
| `idx_ii_tax_lots_user` | `CREATE INDEX idx_ii_tax_lots_user ON public.ii_tax_lots USING btree (user_id)` |
| `ii_tax_lots_pkey` | `CREATE UNIQUE INDEX ii_tax_lots_pkey ON public.ii_tax_lots USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_tax_lots` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_tax_rule_versions`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `rule_set_key` | text | NO | — |
| `version` | text | NO | — |
| `country_code` | character | NO | — |
| `rule_definition` | jsonb | NO | — |
| `effective_from` | date | NO | — |
| `effective_to` | date | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_tax_rule_versions_country_code_fkey` | FOREIGN KEY | `FOREIGN KEY (country_code) REFERENCES countries(country_code)` |
| `ii_tax_rule_versions_country_code_not_null` | n | `NOT NULL country_code` |
| `ii_tax_rule_versions_effective_from_not_null` | n | `NOT NULL effective_from` |
| `ii_tax_rule_versions_id_not_null` | n | `NOT NULL id` |
| `ii_tax_rule_versions_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_tax_rule_versions_rule_definition_not_null` | n | `NOT NULL rule_definition` |
| `ii_tax_rule_versions_rule_set_key_not_null` | n | `NOT NULL rule_set_key` |
| `ii_tax_rule_versions_rule_set_key_version_key` | UNIQUE | `UNIQUE (rule_set_key, version)` |
| `ii_tax_rule_versions_version_not_null` | n | `NOT NULL version` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_tax_rule_versions_country` | `CREATE INDEX idx_ii_tax_rule_versions_country ON public.ii_tax_rule_versions USING btree (country_code)` |
| `ii_tax_rule_versions_pkey` | `CREATE UNIQUE INDEX ii_tax_rule_versions_pkey ON public.ii_tax_rule_versions USING btree (id)` |
| `ii_tax_rule_versions_rule_set_key_version_key` | `CREATE UNIQUE INDEX ii_tax_rule_versions_rule_set_key_version_key ON public.ii_tax_rule_versions USING btree (rule_set_key, version)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `read ii_tax_rule_versions` | SELECT | {public} | `true` | `-` |

### `ii_transaction_source_links`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `transaction_id` | uuid | NO | — |
| `source_document_id` | uuid | NO | — |
| `parse_run_id` | uuid | YES | — |
| `observed_at` | timestamp with time zone | NO | `now()` |
| `is_originating` | boolean | NO | `false` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_transaction_source_links_id_not_null` | n | `NOT NULL id` |
| `ii_transaction_source_links_is_originating_not_null` | n | `NOT NULL is_originating` |
| `ii_transaction_source_links_observed_at_not_null` | n | `NOT NULL observed_at` |
| `ii_transaction_source_links_parse_run_id_fkey` | FOREIGN KEY | `FOREIGN KEY (parse_run_id) REFERENCES ii_document_parse_runs(id)` |
| `ii_transaction_source_links_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_transaction_source_links_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id) ON DELETE CASCADE` |
| `ii_transaction_source_links_source_document_id_not_null` | n | `NOT NULL source_document_id` |
| `ii_transaction_source_links_transaction_id_fkey` | FOREIGN KEY | `FOREIGN KEY (transaction_id) REFERENCES ii_transactions(id) ON DELETE CASCADE` |
| `ii_transaction_source_links_transaction_id_not_null` | n | `NOT NULL transaction_id` |
| `ii_transaction_source_links_transaction_id_source_document__key` | UNIQUE | `UNIQUE (transaction_id, source_document_id)` |
| `ii_transaction_source_links_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_transaction_source_links_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_transaction_source_links_document` | `CREATE INDEX idx_ii_transaction_source_links_document ON public.ii_transaction_source_links USING btree (source_document_id)` |
| `idx_ii_transaction_source_links_transaction` | `CREATE INDEX idx_ii_transaction_source_links_transaction ON public.ii_transaction_source_links USING btree (transaction_id)` |
| `idx_ii_transaction_source_links_user` | `CREATE INDEX idx_ii_transaction_source_links_user ON public.ii_transaction_source_links USING btree (user_id)` |
| `ii_transaction_source_links_pkey` | `CREATE UNIQUE INDEX ii_transaction_source_links_pkey ON public.ii_transaction_source_links USING btree (id)` |
| `ii_transaction_source_links_transaction_id_source_document__key` | `CREATE UNIQUE INDEX ii_transaction_source_links_transaction_id_source_document__key ON public.ii_transaction_source_links USING btree (transaction_id, source_document_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_transaction_source_links` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

### `ii_transactions`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `account_id` | uuid | NO | — |
| `instrument_id` | uuid | NO | — |
| `source_document_id` | uuid | YES | — |
| `currency_code` | character | NO | — |
| `status` | text | NO | `'parsed'::text` |
| `transaction_type` | text | NO | — |
| `transaction_date` | date | NO | — |
| `units` | numeric | YES | — |
| `price_per_unit` | numeric | YES | — |
| `gross_amount` | numeric | NO | — |
| `corrects_transaction_id` | uuid | YES | — |
| `source_reference` | text | YES | — |
| `created_at` | timestamp with time zone | YES | `now()` |
| `parse_run_id` | uuid | YES | — |
| `parser_code` | text | YES | — |
| `parser_version_used` | text | YES | — |
| `source_description` | text | YES | — |
| `fees` | numeric | YES | — |
| `taxes` | numeric | YES | — |
| `confidence` | numeric | YES | — |
| `transaction_fingerprint` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `ii_transactions_account_id_fkey` | FOREIGN KEY | `FOREIGN KEY (account_id) REFERENCES ii_accounts(id) ON DELETE CASCADE` |
| `ii_transactions_account_id_not_null` | n | `NOT NULL account_id` |
| `ii_transactions_confidence_check` | CHECK | `CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))))` |
| `ii_transactions_corrects_transaction_id_fkey` | FOREIGN KEY | `FOREIGN KEY (corrects_transaction_id) REFERENCES ii_transactions(id)` |
| `ii_transactions_currency_code_fkey` | FOREIGN KEY | `FOREIGN KEY (currency_code) REFERENCES currencies(currency_code)` |
| `ii_transactions_currency_code_not_null` | n | `NOT NULL currency_code` |
| `ii_transactions_gross_amount_not_null` | n | `NOT NULL gross_amount` |
| `ii_transactions_id_not_null` | n | `NOT NULL id` |
| `ii_transactions_instrument_id_fkey` | FOREIGN KEY | `FOREIGN KEY (instrument_id) REFERENCES ii_instruments(id)` |
| `ii_transactions_instrument_id_not_null` | n | `NOT NULL instrument_id` |
| `ii_transactions_parse_run_id_fkey` | FOREIGN KEY | `FOREIGN KEY (parse_run_id) REFERENCES ii_document_parse_runs(id)` |
| `ii_transactions_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `ii_transactions_source_document_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_document_id) REFERENCES ii_source_documents(id)` |
| `ii_transactions_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['parsed'::text, 'reconciled'::text, 'corrected'::text, 'reversed'::text])))` |
| `ii_transactions_status_not_null` | n | `NOT NULL status` |
| `ii_transactions_transaction_date_not_null` | n | `NOT NULL transaction_date` |
| `ii_transactions_transaction_type_check` | CHECK | `CHECK ((transaction_type = ANY (ARRAY['purchase'::text, 'sip'::text, 'redemption'::text, 'switch_in'::text, 'switch_out'::text, 'dividend'::text, 'reinvestment'::text, 'transfer'::text, 'merger'::text, 'fee'::text, 'tax'::text, 'adjustment'::text, 'stp_in'::text, 'stp_out'::text, 'swp'::text, 'transfer_in'::text, 'transfer_out'::text, 'reversal'::text, 'segregation'::text, 'unclassified'::text])))` |
| `ii_transactions_transaction_type_not_null` | n | `NOT NULL transaction_type` |
| `ii_transactions_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `ii_transactions_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_ii_transactions_account_date` | `CREATE INDEX idx_ii_transactions_account_date ON public.ii_transactions USING btree (account_id, transaction_date)` |
| `idx_ii_transactions_parse_run` | `CREATE INDEX idx_ii_transactions_parse_run ON public.ii_transactions USING btree (parse_run_id) WHERE (parse_run_id IS NOT NULL)` |
| `idx_ii_transactions_user` | `CREATE INDEX idx_ii_transactions_user ON public.ii_transactions USING btree (user_id)` |
| `ii_transactions_pkey` | `CREATE UNIQUE INDEX ii_transactions_pkey ON public.ii_transactions USING btree (id)` |
| `uidx_ii_transactions_dedup` | `CREATE UNIQUE INDEX uidx_ii_transactions_dedup ON public.ii_transactions USING btree (account_id, source_document_id, source_reference) WHERE ((source_document_id IS NOT NULL) AND (source_reference IS NOT NULL))` |
| `uidx_ii_transactions_fingerprint` | `CREATE UNIQUE INDEX uidx_ii_transactions_fingerprint ON public.ii_transactions USING btree (account_id, transaction_fingerprint) WHERE (transaction_fingerprint IS NOT NULL)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own ii_transactions` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |
