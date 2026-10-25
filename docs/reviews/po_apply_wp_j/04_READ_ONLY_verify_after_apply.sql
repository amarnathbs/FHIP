-- WP-J / Document2 (4) -- READ ONLY. Changes nothing. Run after 02 and 03, on DEV first. Every expected answer is written next to the block.

-- BLOCK 1: the three counter columns. Expected: three rows, data_type integer, is_nullable NO, column_default 0.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_name = 'ii_document_parse_runs'
   and column_name in ('duplicate_transactions_linked', 'new_transactions_count', 'missing_transactions_count')
 order by column_name;

-- BLOCK 2: the job tables exist with row level security on. Expected: two rows, rls_on true.
select c.relname as table_name, c.relrowsecurity as rls_on
  from pg_class c
 where c.relname in ('ii_statement_jobs', 'ii_statement_job_chunks') and c.relkind = 'r'
 order by c.relname;

-- BLOCK 3: policies. Expected: exactly ONE row, the select policy on ii_statement_jobs. No policy at all on the staging table, and no
-- insert, update or delete policy for anyone: only the server writes.
select tablename, policyname, cmd
  from pg_policies
 where tablename in ('ii_statement_jobs', 'ii_statement_job_chunks')
 order by tablename, policyname;

-- BLOCK 4: the lease functions are callable by the server only. Expected: browser_can_call false on all three, server_can_call true.
select p.proname as function_name,
       has_function_privilege('authenticated', p.oid, 'execute') as browser_can_call,
       has_function_privilege('service_role', p.oid, 'execute') as server_can_call
  from pg_proc p
 where p.proname in ('ii_statement_job_claim', 'ii_statement_job_claim_next', 'ii_statement_job_heartbeat')
 order by p.proname;

-- BLOCK 5: the one-active-job index and the key index. Expected: both present.
select indexname from pg_indexes
 where tablename = 'ii_statement_jobs' and indexname in ('uq_ii_statement_jobs_one_active', 'uq_ii_statement_jobs_idempotency', 'idx_ii_statement_jobs_work')
 order by indexname;

-- BLOCK 6: the tables are empty and nothing is stuck. Expected: zero jobs, zero staging rows.
select (select count(*) from ii_statement_jobs) as jobs, (select count(*) from ii_statement_job_chunks) as staging_rows;
