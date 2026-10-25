-- WP-J / Document2 (4) -- READ ONLY. Changes nothing. Run on DEV first, then on production, BEFORE 02 and 03.
-- Run each block on its own in the Supabase SQL editor. Nothing here shows a statement line, an amount, a name or a file name.

-- BLOCK 1: are the new objects already there? Expected before applying: every row says false (the counter columns row may say true on
-- production, where the three columns were added by hand on 22-10-2026).
select 'ii_statement_jobs table' as item, to_regclass('public.ii_statement_jobs') is not null as present
union all
select 'ii_statement_job_chunks table', to_regclass('public.ii_statement_job_chunks') is not null
union all
select 'claim function', to_regprocedure('public.ii_statement_job_claim(uuid,text,integer)') is not null
union all
select 'counter column duplicate_transactions_linked', exists (select 1 from information_schema.columns where table_name = 'ii_document_parse_runs' and column_name = 'duplicate_transactions_linked')
union all
select 'counter column new_transactions_count', exists (select 1 from information_schema.columns where table_name = 'ii_document_parse_runs' and column_name = 'new_transactions_count')
union all
select 'counter column missing_transactions_count', exists (select 1 from information_schema.columns where table_name = 'ii_document_parse_runs' and column_name = 'missing_transactions_count');

-- BLOCK 2: the tables this change builds on must already exist. Expected: every row says true.
select 'ii_source_documents' as item, to_regclass('public.ii_source_documents') is not null as present
union all
select 'ii_document_parse_runs', to_regclass('public.ii_document_parse_runs') is not null
union all
select 'ii_transactions', to_regclass('public.ii_transactions') is not null
union all
select 'transactions.corrects_transaction_id (WP-H3)', exists (select 1 from information_schema.columns where table_name = 'ii_transactions' and column_name = 'corrects_transaction_id');

-- BLOCK 3: processing runs that are still marked running. A run that is older than a few minutes and has no job behind it is dead (the
-- platform ended the request). Counts and ages only. After the new code is live these are closed on their own, with an honest reason.
select run_status, count(*) as runs, min(started_at) as oldest_start, max(started_at) as newest_start
  from ii_document_parse_runs
 where run_status in ('queued', 'running')
 group by run_status;

-- BLOCK 4: statements by status, so you can see how many are waiting for a password, failed to parse or never processed. Counts only.
select status, count(*) as statements from ii_source_documents group by status order by statements desc;
