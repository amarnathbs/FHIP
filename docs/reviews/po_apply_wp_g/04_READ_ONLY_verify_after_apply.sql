-- WP-G / Document2 (4) F15 -- READ ONLY. Changes nothing. Run after 02 and 03, on the same database. Each block on its own.

-- BLOCK 1: both tables exist, row-level security is on, and a browser can only READ its own jobs.
select c.relname as table_name, c.relrowsecurity as rls_on
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('fdh_bank_import_jobs', 'fdh_bank_import_job_chunks')
 order by 1;
-- Expected: two rows, rls_on = true for both.

select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename in ('fdh_bank_import_jobs', 'fdh_bank_import_job_chunks')
 order by 1, 2;
-- Expected: exactly one policy, on fdh_bank_import_jobs, command SELECT. None on the chunks table (staging is server-only).

-- BLOCK 2: the three lease functions exist and ONLY the server role may run them.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_browser_can_run,
       has_function_privilege('service_role', p.oid, 'execute') as server_can_run
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'fdh_bank_import_%'
 order by 1;
-- Expected: the claim, claim_next and heartbeat functions (plus the two owner-check trigger functions, which are not callable as functions);
-- for the three lease functions anon_can_run = false, signed_in_browser_can_run = false, server_can_run = true.

-- BLOCK 3: the unique line index (only if 0311 found no duplicates).
select indexname, indexdef from pg_indexes where tablename = 'fdh_transactions' and indexname = 'uq_fdh_transactions_statement_source_row';
-- Expected: one row. If there is none, run block 3 of 01_READ_ONLY_before_apply.sql: duplicates existed and the index was deliberately skipped.

-- BLOCK 4: both tables are empty right after applying (nothing has been imported through the new path yet).
select (select count(*) from fdh_bank_import_jobs) as jobs, (select count(*) from fdh_bank_import_job_chunks) as staged_chunks;
