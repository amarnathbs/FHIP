-- File 10 (optional, read only): which document sweep jobs are scheduled on DEV right now.
-- Why: the migration history says DEV must have NO purge or malware sweep job (migration 0229),
-- but Claude has no way to read the cron schedule, so only the SQL editor can answer.
-- Expected: zero rows. Any row here is a finding to paste back, nothing to fix by hand.

select jobname, schedule, active, left(command, 90) as command_start
  from cron.job
 where jobname in ('lr1-document-purge-sweep', 'aie1-document-purge-sweep', 'fdh3-malware-scan-sweep', 'aie1-malware-scan-sweep')
 order by jobname;
