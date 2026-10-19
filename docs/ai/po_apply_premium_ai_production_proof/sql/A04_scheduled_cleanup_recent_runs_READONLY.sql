-- A04 READ-ONLY. The last runs of those four jobs. Needs the cron schema run log (not present in every environment).
-- Expected: recent rows with status succeeded. A job that never ran, or always fails, means originals are not removed on time.

select j.jobname, d.status, d.start_time, d.end_time
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname in ('lr1-document-purge-sweep', 'aie1-document-purge-sweep', 'fdh3-malware-scan-sweep', 'aie1-malware-scan-sweep')
   and d.start_time >= now() - interval '2 hours'
 order by d.start_time desc
 limit 40;
