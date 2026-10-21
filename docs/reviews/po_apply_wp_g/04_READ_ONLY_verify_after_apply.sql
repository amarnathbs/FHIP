-- WP-G / Document2 (4) F15 -- READ ONLY. Changes nothing. Run after 02 and 03, on the same database. Each block on its own.

-- BLOCK 1: both tables exist and row-level security is on. Expected: two rows, rls_on true for both.
select c.relname as table_name, c.relrowsecurity as rls_on
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('fdh_bank_import_jobs', 'fdh_bank_import_job_chunks')
 order by 1;

-- BLOCK 2: policies. Expected: exactly one policy, on fdh_bank_import_jobs, command SELECT. None on the chunks table (staging is server-only).
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename in ('fdh_bank_import_jobs', 'fdh_bank_import_job_chunks')
 order by 1, 2;

-- BLOCK 3: who may run the functions. Expected: for claim_job, claim_next and heartbeat, anon_can_run false,
-- signed_in_browser_can_run false, server_can_run true. The two owner-check trigger functions are listed too and are not callable as functions.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_browser_can_run,
       has_function_privilege('service_role', p.oid, 'execute') as server_can_run
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('fdh_bank_import_claim_job', 'fdh_bank_import_claim_next', 'fdh_bank_import_heartbeat', 'fdh_bank_import_assert_job_owner', 'fdh_bank_import_assert_chunk_owner')
 order by 1;

-- BLOCK 4: the unique line index, present only if 0311 found no duplicates. Expected: one row. If there is none, run block 3 of
-- 01_READ_ONLY_before_apply.sql: duplicates existed and the index was deliberately skipped.
select indexname, indexdef from pg_indexes where tablename = 'fdh_transactions' and indexname = 'uq_fdh_transactions_statement_source_row';

-- BLOCK 5: both tables are empty right after applying (nothing has been imported through the new path yet).
select (select count(*) from fdh_bank_import_jobs) as jobs, (select count(*) from fdh_bank_import_job_chunks) as staged_chunks;
