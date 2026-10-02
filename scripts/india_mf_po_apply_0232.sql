-- PO APPLY SCRIPT — migration 0232 (market-index upload capability, ledger, RPCs).
--
-- STATUS: NOT APPLIED to DEV or production. Applying it is the PO's step.
-- Order: DEV first (project vqycarelcoijzwlpkpcz). Production
-- (twwpnltizhtjxhamyoxt) only after DEV verification and PO sign-off.
--
-- STEP 1. Run the whole file supabase/migrations/0232_market_index_data_upload_and_feed.sql
--         in the Supabase SQL editor. It is idempotent: running it twice is safe.
--
-- STEP 2. Verify (run each; expected result in the comment):
--
-- 2a. capability column exists and defaults to false for every existing admin
select count(*) as admins, count(*) filter (where can_upload_market_index_data) as with_capability
  from admin_users;                                   -- with_capability = 0
-- 2b. two price-index benchmark rows, licence_status 'unknown', mapped to no fund
select benchmark_key, return_type, licence_status from ii_benchmarks
 where benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI');   -- 2 rows
select count(*) as mapped_funds from ii_instrument_benchmarks ib
  join ii_benchmarks b on b.id = ib.benchmark_id
 where b.benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI'); -- 0
-- 2c. the daily feed job exists and is DISABLED; there is no schedule
select job_key, enabled, left(disabled_reason, 60) from ii_reference_job_control
 where job_key = 'market_index_daily_close';                     -- enabled = false
select count(*) as schedules from cron.job where jobname ilike '%market%index%';  -- 0
-- 2d. the ledger is append-only (this must ERROR with "append-only")
--     (run only on DEV; the table is empty so this is harmless)
-- update ii_market_index_batches set file_name = 'x';
-- 2e. RLS is on
select relname, relrowsecurity from pg_class where relname = 'ii_market_index_batches';  -- true
--
-- STEP 3. Grant the capability to the named administrator(s) who will upload.
--         It is deliberately NOT granted to anyone by the migration, and is not
--         implied by any other admin flag. Replace the e-mail, run once:
-- update admin_users set can_upload_market_index_data = true
--  where user_id = (select id from auth.users where email = 'REPLACE_WITH_ADMIN_EMAIL');
--
-- STEP 4. Sign in as that administrator, open Admin > Market Index Data
--         (/admin/investment-intelligence/market-index-data), upload the Nifty 50
--         and the Sensex CSV files (one file per index; Preview first), tick the
--         attestation and commit. Confirm the "Latest close" row for each index.
--
-- STEP 5. DO NOT enable the daily feed until NSE/BSE terms are confirmed (or a
--         licence is held). When that is decided, enabling needs BOTH:
--           a) environment variable MARKET_INDEX_FEED_ENABLED=true on the app, and
--           b) update ii_reference_job_control set enabled = true, disabled_reason = null
--               where job_key = 'market_index_daily_close';
--         plus a human-created schedule that POSTs to
--         /api/investment-intelligence/cron/market-index-daily with the x-cron-secret header.
--         For the Sensex, also set MARKET_INDEX_BSE_CSV_URL_TEMPLATE to a permitted
--         https URL containing {DDMMYYYY} or {YYYY-MM-DD}; without it the Sensex
--         adapter reports not_configured and makes no request.
--
-- ROLLBACK (only if no uploads exist that must be kept):
--   drop function if exists commit_market_index_upload(text, text, text, jsonb, boolean, text);
--   drop function if exists record_market_index_feed_closes(text, jsonb, text);
--   -- the ledger is append-only by design; to drop it, first drop its triggers:
--   drop trigger if exists trg_ii_market_index_batches_no_update on ii_market_index_batches;
--   drop trigger if exists trg_ii_market_index_batches_no_truncate on ii_market_index_batches;
--   drop table if exists ii_market_index_batches;
--   delete from ii_benchmark_series where benchmark_id in
--     (select id from ii_benchmarks where benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI'));
--   delete from ii_benchmarks where benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI');
--   delete from ii_reference_job_control where job_key = 'market_index_daily_close';
--   drop function if exists is_market_index_data_admin();
--   alter table admin_users drop column if exists can_upload_market_index_data;
--   drop function if exists ii_market_index_batches_append_only();
