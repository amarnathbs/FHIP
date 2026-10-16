-- READ ONLY. The user is found through the report id, so no name or email is typed or shown.

-- 1. Every report version for this user: status, size and when it was made. section_count 0 on a ready report = empty shell.
select r.id, r.report_month, r.version_number, r.status, r.revises_report_id, r.failure_code,
       r.created_at, r.generated_at,
       (select count(*) from report_sections s where s.report_id = r.id) as section_count,
       (select coalesce(sum(pg_column_size(s.section_data_json)), 0) from report_sections s where s.report_id = r.id) as total_data_bytes
  from reports r
 where r.user_id = (select x.user_id from reports x where x.id = '0b9a5749-64a5-4268-9f00-c55228424836')
 order by r.created_at desc;

-- 2. Every generation attempt, newest first, with how long it took in seconds.
--    output_status: succeeded, failed, started (still running or cut off), abandoned, already_exists, deferred_in_flight.
--    A run still 'started' with seconds empty and a start time older than a few minutes was cut off by the platform.
select g.id, g.trigger_type, g.output_status, g.started_at, g.completed_at,
       round(extract(epoch from (g.completed_at - g.started_at))::numeric, 1) as seconds,
       g.report_id, left(coalesce(g.failure_details, ''), 160) as failure_details
  from report_generation_runs g
 where g.user_id = (select x.user_id from reports x where x.id = '0b9a5749-64a5-4268-9f00-c55228424836')
 order by g.started_at desc
 limit 25;

-- 3. Export attempts for this report (the PDF 500): status and the stored error code.
select e.id, e.export_format, e.status, e.error_code, e.requested_at, e.completed_at
  from report_exports e
 where e.report_id = '0b9a5749-64a5-4268-9f00-c55228424836'
 order by e.requested_at desc;
