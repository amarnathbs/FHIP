-- WP-G / Document2 (4) F15 -- READ ONLY. Changes nothing. Use after deployment to see how bank imports are doing. Counts and codes only.

-- BLOCK 1: jobs by state in the last 7 days.
select status, phase, count(*) as jobs
  from fdh_bank_import_jobs
 where created_at > now() - interval '7 days'
 group by status, phase
 order by 1, 2;

-- BLOCK 2: unfinished jobs nobody is working on right now (the lease ran out). Healthy: none for more than a couple of minutes.
-- If this keeps showing rows, the browser is not open and the scheduled backstop (file 05) is not running.
select id, status, phase, progress_done, progress_total, slice_count, reclaim_count,
       round(extract(epoch from (now() - coalesce(lease_expires_at, updated_at)))::numeric) as seconds_without_a_worker
  from fdh_bank_import_jobs
 where status in ('queued', 'processing')
   and (lease_expires_at is null or lease_expires_at < now())
 order by updated_at
 limit 20;

-- BLOCK 3: failed jobs by reason in the last 7 days.
select error_code, count(*) as jobs
  from fdh_bank_import_jobs
 where status = 'failed' and created_at > now() - interval '7 days'
 group by error_code
 order by 2 desc;

-- BLOCK 4: staging left behind. Should be empty once jobs finish. The backstop sweeps failed and finished jobs after 24 hours.
select j.status, count(c.id) as staged_chunks
  from fdh_bank_import_job_chunks c join fdh_bank_import_jobs j on j.id = c.job_id
 group by j.status;

-- BLOCK 5: the F15 diagnosis of the old failure: bank statements stuck in processing with no job (debris of a request the platform ended).
select d.id as document_id, d.processing_started_at, count(t.id) as partial_lines
  from fdh_statement_uploads d
  left join fdh_bank_import_jobs j on j.statement_upload_id = d.id
  left join fdh_transactions t on t.statement_upload_id = d.id
 where d.document_type = 'bank_statement' and d.processing_status = 'processing' and j.id is null
 group by d.id, d.processing_started_at
 order by d.processing_started_at
 limit 20;
