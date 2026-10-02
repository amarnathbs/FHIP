-- BENCH-1 Phase 2 - PO apply script for migration 0241 (DEV first; production only after sign-off).
-- Run in the Supabase SQL editor of the TARGET project, in this order. Nothing here grants a capability,
-- approves an entitlement, loads an index level or enables a job.
--
-- STEP 0  PRECONDITIONS (run, read the output)
--   0232 must already be applied (is_market_index_data_admin exists) and 0155 (PC6 ledgers). If the first select
--   returns false, apply supabase/migrations/0232_market_index_data_upload_and_feed.sql (see scripts/india_mf_po_apply_0232.sql) first.
select to_regprocedure('is_market_index_data_admin()') is not null as has_0232,
       to_regclass('public.ii_reference_import_batches') is not null as has_0155,
       (select count(*) from ii_benchmarks) as benchmarks_now,
       (select count(*) from ii_benchmark_series) as series_now;

-- STEP 1  APPLY: paste and run the WHOLE of supabase/migrations/0241_bench1_phase2_benchmark_data_governance.sql
--   (idempotent; safe to re-run). Re-scan migration numbers on all branches before applying to production.

-- STEP 2  VERIFY (expected results in the comments)
-- 2a. four new capability columns, all false for everyone:           expect 4 rows, granted = 0
select column_name from information_schema.columns where table_name = 'admin_users' and column_name in
  ('can_publish_benchmark_data','can_correct_benchmark_data','can_manage_benchmark_catalogue','can_approve_benchmark_entitlements');
select count(*) as granted from admin_users where can_publish_benchmark_data or can_correct_benchmark_data or can_manage_benchmark_catalogue or can_approve_benchmark_entitlements;
-- 2b. kill switches exist and are OFF:                                expect 2 rows, enabled = false
select job_key, enabled from ii_reference_job_control where job_key in ('benchmark_ingestion_global','benchmark_ingestion_write');
-- 2c. no schedule was created:                                         expect 0 rows
select jobname from cron.job where jobname ilike '%benchmark%';
-- 2d. RLS gate on the series is in place (policy text mentions benchmark_calc_readable_ids): expect 1 row
select policyname from pg_policies where tablename = 'ii_benchmark_series' and qual ilike '%benchmark_calc_readable_ids%';
-- 2e. the 0232 single-step upload RPC is no longer executable by signed-in users: expect false
select has_function_privilege('authenticated', 'commit_market_index_upload(text,text,text,jsonb,boolean,text)', 'execute') as legacy_upload_executable;
-- 2f. no benchmark data appeared:                                      expect 0 / 0 (or the two 0232 seed rows only)
select (select count(*) from ii_benchmark_series) as series_rows, (select count(*) from ii_benchmark_entitlements) as entitlements;

-- STEP 3  GRANT CAPABILITIES (deliberate, one administrator at a time; example only - edit and run the lines you intend)
-- update admin_users set can_manage_benchmark_catalogue = true where user_id = '<catalogue-admin-uuid>';
-- update admin_users set can_approve_benchmark_entitlements = true where user_id = '<approver-uuid>';
-- update admin_users set can_upload_market_index_data = true where user_id = '<uploader-uuid>';
-- update admin_users set can_publish_benchmark_data = true where user_id = '<publisher-uuid>';
-- update admin_users set can_correct_benchmark_data = true where user_id = '<corrector-uuid>';

-- STEP 4  OPTIONAL SEED (draft catalogue entries + mapping PROPOSALS only):
--   docs/admin/po_apply_bench1_phase2/03_seed_catalogue_and_mapping_proposals.sql (edit <ADMIN_USER_UUID>; DEV first).

-- ROLLBACK (drops only 0241 objects; does not touch 0232 or any other migration). Run only if 0241 must be withdrawn.
-- Order matters (dependencies). Series rows written under 0241 keep their data; the added columns are dropped.
-- drop function if exists publish_benchmark_feed_rows(uuid, jsonb, text, text);
-- drop function if exists record_benchmark_ingestion_attempt(uuid, jsonb);
-- drop function if exists release_benchmark_ingestion_lease(uuid, text);
-- drop function if exists claim_benchmark_ingestion_lease(uuid, text, integer);
-- drop function if exists set_benchmark_ingestion_mode(uuid, text, text, text, boolean, integer, text);
-- drop function if exists upsert_benchmark_history_demand(jsonb, text);
-- drop function if exists expire_benchmark_import_jobs();
-- drop function if exists cancel_benchmark_import_job(uuid);
-- drop function if exists record_benchmark_import_failure(uuid, text, text);
-- drop function if exists rollback_benchmark_import(uuid, text);
-- drop function if exists publish_benchmark_import(uuid, jsonb);
-- drop function if exists finalize_benchmark_import_job(uuid, jsonb);
-- drop function if exists stage_benchmark_import_rows(uuid, jsonb, jsonb);
-- drop function if exists create_benchmark_import_job(jsonb);
-- drop function if exists ii_bm_staging_digest(uuid);
-- drop function if exists verify_benchmark_catalogue_entry(uuid, text);
-- drop function if exists upsert_benchmark_catalogue_entry(jsonb);
-- drop function if exists auto_publish_benchmark_mapping(uuid);
-- drop function if exists review_benchmark_mapping(uuid, text, text, boolean);
-- drop function if exists ii_bm_apply_mapping(uuid, uuid, boolean, boolean, text);
-- drop function if exists propose_benchmark_mapping(jsonb);
-- drop function if exists revoke_benchmark_entitlement(uuid, text);
-- drop function if exists approve_benchmark_entitlement(uuid, text, boolean);
-- drop function if exists propose_benchmark_entitlement(jsonb);
-- -- restore the permissive reader policy ONLY if you accept un-gated series reads:
-- drop policy if exists "read ii_benchmark_series" on ii_benchmark_series;
-- create policy "read ii_benchmark_series" on ii_benchmark_series for select using (true);
-- drop function if exists benchmark_calc_readable_ids();
-- drop function if exists benchmark_entitled_actions(uuid[], date);
-- drop function if exists benchmark_entitlement_id_allows(uuid, text, date, date, date);
-- drop function if exists benchmark_right_allowed(uuid, text, date, date, date);
-- drop function if exists benchmark_entitlement_grants(ii_benchmark_entitlements, text, date);
-- drop trigger if exists trg_ii_instrument_benchmarks_no_primary_overlap on ii_instrument_benchmarks;
-- drop function if exists ii_instrument_benchmarks_no_primary_overlap();
-- drop table if exists ii_benchmark_ingestion_runs, ii_benchmark_ingestion_state, ii_benchmark_history_demand,
--   ii_benchmark_mapping_proposals, ii_benchmark_import_errors, ii_benchmark_import_rows, ii_benchmark_import_jobs,
--   ii_benchmark_entitlements, ii_benchmark_governance_events cascade;
-- drop function if exists ii_bm_log_event(text, text, uuid, jsonb, jsonb, text);
-- drop function if exists ii_benchmark_governance_events_append_only();
-- drop function if exists is_benchmark_data_viewer(); drop function if exists is_benchmark_entitlement_approver();
-- drop function if exists is_benchmark_catalogue_admin(); drop function if exists is_benchmark_corrector(); drop function if exists is_benchmark_publisher();
-- delete from ii_reference_job_control where job_key in ('benchmark_ingestion_global','benchmark_ingestion_write');
-- alter table admin_users drop column if exists can_publish_benchmark_data, drop column if exists can_correct_benchmark_data,
--   drop column if exists can_manage_benchmark_catalogue, drop column if exists can_approve_benchmark_entitlements;
-- -- additive columns on ii_benchmarks / ii_benchmark_series / ii_instrument_benchmarks are harmless; drop them only with the data owner's agreement.
-- -- To re-allow the 0232 single-step upload RPC (not recommended: it bypasses the entitlement gate):
-- -- grant execute on function commit_market_index_upload(text, text, text, jsonb, boolean, text) to authenticated;
