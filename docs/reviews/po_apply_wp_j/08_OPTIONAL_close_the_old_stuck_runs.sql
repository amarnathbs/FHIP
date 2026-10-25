-- WP-J / Document2 (4) -- OPTIONAL DATA CHANGE. Closes the processing runs that were left marked running by requests the platform ended
-- (the three old runs seen on production). You do NOT have to run this: once the new code is live, the next attempt on a statement and the
-- scheduled backstop close such a run on their own, with the same reason. Run it only if you want them closed now.
--
-- IT CHANGES DATA, so production needs the manual backup first (production has no managed backups). Run the blocks ONE AT A TIME, in order,
-- on DEV first.
--   A. backup of exactly the rows that will change (a new table, nothing existing is touched)
--   B. preview of the rows (read only)
--   C. the change: only runs older than 10 minutes that are still queued or running, and only if no unfinished statement job belongs to the
--      statement. They become failed with a plain reason. They are NEVER marked succeeded, and nothing they wrote is touched.
--   D. verify (read only)
--   The undo is a separate file, 09, kept apart so it can never be run by accident.

-- BLOCK A: backup. Run this first and confirm the row count is the number you expect (three on production).
create table if not exists ii_document_parse_runs_backup_wpj_20261025 as
select id, run_status, completed_at, errors, now() as saved_at
  from ii_document_parse_runs
 where run_status in ('queued', 'running')
   and started_at < now() - interval '10 minutes'
   and not exists (select 1 from ii_statement_jobs j where j.source_document_id = ii_document_parse_runs.source_document_id and j.status in ('queued', 'processing'));

select count(*) as rows_saved from ii_document_parse_runs_backup_wpj_20261025;

-- BLOCK B: preview (read only). Ages and statuses only.
select r.id, r.run_status, r.started_at, now() - r.started_at as age
  from ii_document_parse_runs r
  join ii_document_parse_runs_backup_wpj_20261025 b on b.id = r.id
 order by r.started_at;

-- BLOCK C: the change.
update ii_document_parse_runs r
   set run_status = 'failed',
       completed_at = now(),
       errors = jsonb_build_array(jsonb_build_object('code', 'run_abandoned', 'message', 'The earlier processing attempt stopped without finishing and showed no sign of progress, so it was closed as failed. Nothing that attempt did was counted as processed. The statement can be processed again.', 'severity', 'error'))
 where r.id in (select id from ii_document_parse_runs_backup_wpj_20261025)
   and r.run_status in ('queued', 'running');

-- BLOCK D: verify (read only). Expected: no row of the backup is still running.
select r.run_status, count(*) as runs
  from ii_document_parse_runs r
  join ii_document_parse_runs_backup_wpj_20261025 b on b.id = r.id
 group by r.run_status;
