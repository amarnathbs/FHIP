-- WP-G / Document2 (4) F15 -- READ ONLY. Changes nothing. Run on DEV first, then on production, BEFORE 02_APPLY_0310.
-- Run each block on its own in the Supabase SQL editor. Nothing here shows a statement line, an amount, a description or a file name.

-- BLOCK 1: are the new tables and functions already there? (Expected before applying: every row says false.)
select 'fdh_bank_import_jobs table' as item, to_regclass('public.fdh_bank_import_jobs') is not null as present
union all
select 'fdh_bank_import_job_chunks table', to_regclass('public.fdh_bank_import_job_chunks') is not null
union all
select 'claim function', to_regprocedure('public.fdh_bank_import_claim_job(uuid,text,integer)') is not null
union all
select 'unique line index (0311)', to_regclass('public.uq_fdh_transactions_statement_source_row') is not null;

-- BLOCK 2: the tables this change builds on must already exist (Expected: every row says true).
select 'fdh_statement_uploads' as item, to_regclass('public.fdh_statement_uploads') is not null as present
union all
select 'fdh_transactions', to_regclass('public.fdh_transactions') is not null
union all
select 'fdh_ai_fallback_drafts (0197)', to_regclass('public.fdh_ai_fallback_drafts') is not null
union all
select 'aie cost ledger per user cap (0284)', exists (select 1 from information_schema.columns where table_name = 'aie_ai_cost_ledger' and column_name = 'user_daily_cap_usd');

-- BLOCK 3: would the unique line index (0311) be created? (Expected: no rows. A row means a statement already holds two lines with the same
-- row number; 0311 then skips the index on its own and tells you so. Send the row count, not the rows.)
select statement_upload_id, source_row, count(*) as lines
  from fdh_transactions
 where statement_upload_id is not null and source_row is not null
 group by statement_upload_id, source_row
having count(*) > 1
 limit 20;

-- BLOCK 4: statements stuck in processing right now (the F15 debris of the old synchronous import). Counts only.
select processing_status, count(*) as statements, min(processing_started_at) as oldest_start
  from fdh_statement_uploads
 where document_type = 'bank_statement' and processing_status in ('processing', 'queued', 'failed')
 group by processing_status;
