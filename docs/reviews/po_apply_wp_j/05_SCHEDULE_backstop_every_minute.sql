-- WP-J / Document2 (4) -- OPTIONAL BUT RECOMMENDED: the scheduled backstop for statement processing jobs.
--
-- WHAT IT DOES. Once a minute the database asks the app to advance any statement job that nobody is driving any more (a closed tab, a laptop
-- that went to sleep, a slice the platform ended). The same call closes processing runs that are dead (a run that stays running with nothing
-- working on it) and removes staging left behind by ended jobs. Without it a job still finishes while the person has the page open. A closed
-- page simply waits until the statement page is opened again, and a protected statement waits for its password in any case.
--
-- It is the same mechanism this project already uses for the purge, malware-scan and bank import sweeps: pg_cron plus pg_net, with the secret
-- read when the job runs, out of the Supabase Vault. NOTHING SECRET IS WRITTEN IN THIS FILE. There is ONE scheduler for this work: do not
-- also schedule another trigger for statement jobs.
--
-- BEFORE RUNNING
--   1. The app version that contains the route /api/investment-intelligence/statement-jobs/cron/advance must be deployed to the SAME
--      environment. Production: after the Amplify deployment is confirmed. DEV has no publicly reachable app, so do not schedule it there.
--   2. The Vault must already hold the project CRON_SECRET under the name used below. The purge sweep job uses lr1_purge_sweep_cron_secret.
--      If that name does not exist on your project, create a Vault secret holding the CRON_SECRET value (Supabase dashboard, Vault page,
--      typed there and never saved in a file) and change the name in the schedule below.
--   3. Replace REPLACE_WITH_APP_ORIGIN below with the production address, https://app.financialhealthplatform.com (production only).
--
-- IDEMPOTENT: it removes an earlier job of the same name first, so it is safe to run twice.

select cron.unschedule('ii-statement-job-advance')
 where exists (select 1 from cron.job where jobname = 'ii-statement-job-advance');

select cron.schedule(
  'ii-statement-job-advance',
  '*/1 * * * *',
  $cron$
  select net.http_post(
    url := 'REPLACE_WITH_APP_ORIGIN/api/investment-intelligence/statement-jobs/cron/advance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lr1_purge_sweep_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- CHECK (read only, run these two on their own after the schedule): the job is registered and has started to run.
select jobid, jobname, schedule, active from cron.job where jobname = 'ii-statement-job-advance';
select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'ii-statement-job-advance') order by start_time desc limit 5;
