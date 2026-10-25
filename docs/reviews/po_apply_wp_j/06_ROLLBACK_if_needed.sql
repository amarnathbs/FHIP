-- WP-J / Document2 (4) -- ROLLBACK. Only if the background statement processing must be removed. Safe order: the schedule first, then the objects.
-- After this the process route falls back to the earlier one-request behaviour (small statements still work, a large one is again limited by
-- the platform request time). Nothing here touches a transaction, a holding, a statement or any customer record: the job tables hold only
-- job state and temporary staging. The three counter columns of 0312 are deliberately LEFT in place (they are harmless and the application
-- writes them).
--
-- Do not run this while a job is in progress for a person: finish or wait first (see 07).

select cron.unschedule('ii-statement-job-advance')
 where exists (select 1 from cron.job where jobname = 'ii-statement-job-advance');

drop function if exists ii_statement_job_claim_next(text, integer);
drop function if exists ii_statement_job_claim(uuid, text, integer);
drop function if exists ii_statement_job_heartbeat(uuid, text, integer);

drop table if exists ii_statement_job_chunks;
drop table if exists ii_statement_jobs;

drop function if exists ii_statement_job_assert_chunk_owner();
drop function if exists ii_statement_job_assert_owner();
