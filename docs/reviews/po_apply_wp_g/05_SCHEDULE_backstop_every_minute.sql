-- WP-G / Document2 (4) F15 -- OPTIONAL BUT RECOMMENDED: the scheduled backstop for bank import jobs.
--
-- WHAT IT DOES. Once a minute the database asks the app to advance any bank import job that nobody is driving any more (a closed tab, a
-- laptop that went to sleep, a slice the platform ended). Without it a job still finishes while the person has the page open. A closed page
-- simply waits until the page is opened again, and the raw-file safety backstop ends an unread upload after 50 minutes.
--
-- It is the same mechanism this project already uses for the purge and malware-scan sweeps (migrations 0135, 0149, 0174, 0228):
-- pg_cron plus pg_net, with the secret read when the job runs, out of the Supabase Vault. NOTHING SECRET IS WRITTEN IN THIS FILE.
--
-- BEFORE RUNNING
--   1. The app version that contains the route /api/financial-data-hub/bank-import-jobs/cron/advance must be deployed to the SAME
--      environment. Production: after the Amplify deployment is confirmed. DEV has no publicly reachable app, so do not schedule it there.
--   2. The Vault must already hold the project CRON_SECRET under the name used below. The purge sweep job uses
--      lr1_purge_sweep_cron_secret. If that name does not exist on your project, create a Vault secret named bank_import_cron_secret
--      holding the CRON_SECRET value (Supabase dashboard, Vault page, or the vault.create_secret function in the SQL editor, typed there
--      and never saved in a file) and change the name in the schedule below.
--   3. Replace REPLACE_WITH_APP_ORIGIN below with the production address, https://app.financialhealthplatform.com (production only).
--
-- IDEMPOTENT: it removes an earlier job of the same name first, so it is safe to run twice.

select cron.unschedule('fdh-bank-import-advance')
 where exists (select 1 from cron.job where jobname = 'fdh-bank-import-advance');

select cron.schedule(
  'fdh-bank-import-advance',
  '*/1 * * * *',
  $cron$
  select net.http_post(
    url := 'REPLACE_WITH_APP_ORIGIN/api/financial-data-hub/bank-import-jobs/cron/advance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lr1_purge_sweep_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- CHECK (read only, run these two on their own after the schedule): the job is registered and has started to run.
select jobid, jobname, schedule, active from cron.job where jobname = 'fdh-bank-import-advance';
select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'fdh-bank-import-advance') order by start_time desc limit 5;
