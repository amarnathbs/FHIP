-- WP-J / Document2 (4) -- READ ONLY. Changes nothing. Run any time after the code is live, to watch statement jobs.
-- Counts, states and ages only: no statement line, amount, name or file name is shown.

-- BLOCK 1: jobs by state in the last 7 days.
select job_kind, status, count(*) as jobs, max(updated_at) as last_activity
  from ii_statement_jobs
 where created_at > now() - interval '7 days'
 group by job_kind, status
 order by job_kind, status;

-- BLOCK 2: unfinished jobs with nobody working on them (the lease ran out). A few seconds is normal between steps. Minutes mean the page was
-- closed and the schedule is not registered, or the app is down.
select id, job_kind, status, phase, progress_done, slice_count, reclaim_count, lease_expires_at, updated_at
  from ii_statement_jobs
 where status in ('queued', 'processing') and (lease_expires_at is null or lease_expires_at < now())
 order by updated_at
 limit 20;

-- BLOCK 3: jobs that ended in failure, with the plain reason and the step they stopped at.
select id, job_kind, phase, attempt, error_code, error_message_sanitised, completed_at
  from ii_statement_jobs
 where status = 'failed'
 order by completed_at desc
 limit 20;

-- BLOCK 4: processing runs still marked running, with their age. After the new code is live this should be empty or very young.
select count(*) as running_runs, min(started_at) as oldest_start
  from ii_document_parse_runs
 where run_status in ('queued', 'running');

-- BLOCK 5: temporary staging currently held (rows and the oldest). It is removed when a job ends and swept after 24 hours.
select count(*) as staging_rows, min(created_at) as oldest from ii_statement_job_chunks;
