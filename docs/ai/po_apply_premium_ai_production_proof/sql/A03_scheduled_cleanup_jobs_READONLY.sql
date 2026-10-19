-- A03 READ-ONLY. The scheduled jobs that finish the malware scan and delete the original files.
-- Without them a document stays in a pending scan or its original file is not removed on time.
-- Expected: all four rows exist and active is true. Names only, no secrets.

select jobname, schedule, active
  from cron.job
 where jobname in ('lr1-document-purge-sweep', 'aie1-document-purge-sweep', 'fdh3-malware-scan-sweep', 'aie1-malware-scan-sweep')
 order by jobname;
