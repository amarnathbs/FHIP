-- WP-G / Document2 (4) F15 -- ROLLBACK. Only if the background import must be removed. Safe order: the schedule first, then the objects.
-- After this the process routes answer 503 not available yet for new imports instead of failing with SQL.
-- Nothing here touches a transaction, a statement or any customer record: the job tables hold only job state and temporary staging.

select cron.unschedule('fdh-bank-import-advance')
 where exists (select 1 from cron.job where jobname = 'fdh-bank-import-advance');

drop index if exists uq_fdh_transactions_statement_source_row;

drop function if exists fdh_bank_import_claim_next(text, integer);
drop function if exists fdh_bank_import_claim_job(uuid, text, integer);
drop function if exists fdh_bank_import_heartbeat(uuid, text, integer);

drop table if exists fdh_bank_import_job_chunks;
drop table if exists fdh_bank_import_jobs;

drop function if exists fdh_bank_import_assert_chunk_owner();
drop function if exists fdh_bank_import_assert_job_owner();
