-- PC6 daily NAV + weekly scheme master -- call the (now time-budgeted) ingest
-- repeatedly through a morning window, with an explicit pg_net timeout.
--
-- WHY. Production runs on AWS Amplify compute, which kills every request at
-- 28 s. The daily NAV job needs more than one request's worth of writes on a
-- normal day (8,715 inserts on 25 Sep), so the job now writes only until an
-- 18 s budget is used, closes its batch as 'partial' (ledger status 'failed',
-- error_code PARTIAL_BATCH_CONTINUING) and expects to be called again; each
-- call re-plans against the database and continues. Only the call that leaves
-- nothing remaining is 'succeeded' and advances last_success_at. Once a run
-- has succeeded, later calls on the same unchanged AMFI file return
-- 'skipped_unchanged_source' without opening a batch. Requires migration 0204
-- (the exact-pair lookup) and the matching application code.
--
-- THE SCHEDULE (all UTC):
--   pc6-reference-ingest        '30-58/2 3 * * 2-6'  03:30-03:58 every 2 min, Tue-Sat
--   pc6-reference-ingest-0400   '0-30/2 4 * * 2-6'   04:00-04:30 every 2 min, Tue-Sat
--       -> one daily window 03:30-04:30, 31 calls a day. A normal day needs
--          3-4 calls; the rest are cheap no-ops. The spare calls also absorb
--          the 15-minute stale-run guard and the first backoff step (15 min)
--          if something does fail. Two jobs because one cron expression
--          cannot say "03:30 to 04:30".
--   pc6-scheme-master-weekly    '0-28/2 3 * * 2'     03:00-03:28 every 2 min, Tuesday
--       -> finishes before the daily window opens, so a scheme discovered this
--          week gets a NAV the same morning. Measured read-only against
--          production (2026-09-25): a no-change week needs ~13 s of reads,
--          and a mass-change week (the first real run wrote 14,341 rows in
--          22 s on an empty table) can exceed 28 s, so it gets the same
--          budgeted, repeated treatment.
-- Same URL, secret and body as 0187/0188.
--
-- TIMEOUT. timeout_milliseconds := 300000 on every job, so pg_net (default
-- 5 s) is never the party that hangs up: on 25 Sep the run stopped when pg_net
-- dropped the request at 5 s. The job itself now returns in ~20 s.
--
-- SUPERSEDES 0202. The unmerged branch fix/nav1-production-completion-2026-09-25
-- carries 0202_nav1_nav_schedules_http_timeout.sql, which re-registers the
-- same two job names with the 300 s timeout but the OLD single-tick schedules
-- ('30 3 * * 2-6', '0 3 * * 2'). This migration includes that timeout, so
-- 0202's intent is fully covered here. 0202 is harmless BEFORE this one
-- (0205 re-registers the jobs), but must never be applied AFTER it: it would
-- put back the single 03:30 tick, and a single budgeted call writes only part
-- of a day. On a fresh replay the order 0202 < 0205 makes this one win.
--
-- PRODUCTION ONLY, exactly like 0193/0194/0202: acts only where
-- ii_nav_retention_policy has environment = 'production'. Anywhere else
-- (DEV, a fresh environment, PGlite) nothing is scheduled and any copy of
-- these three jobs is removed -- they call the PRODUCTION app URL.
--
-- TO STOP. Prefer the kill switch (it records why and leaves the schedule):
--   update ii_reference_job_control set enabled = false,
--     disabled_reason = '<why>', disabled_at = now()
--   where job_key in ('pc6_amfi_daily_nav', 'pc6_amfi_scheme_master');
--
-- Verification: scripts/pc6_0205_pglite_verification.mjs.

do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    perform cron.unschedule('pc6-reference-ingest')
    where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
    perform cron.unschedule('pc6-reference-ingest-0400')
    where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest-0400');
    perform cron.unschedule('pc6-scheme-master-weekly')
    where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');
    raise notice '0205: not the production database -- nothing scheduled; any PC6 NAV/scheme-master job present was removed.';
    return;
  end if;

  -- Daily NAV, 03:30-03:58 UTC Tue-Sat.
  perform cron.unschedule('pc6-reference-ingest')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
  perform cron.schedule(
    'pc6-reference-ingest',
    '30-58/2 3 * * 2-6',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  -- Daily NAV, 04:00-04:30 UTC Tue-Sat (the same call; second half of the window).
  perform cron.unschedule('pc6-reference-ingest-0400')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest-0400');
  perform cron.schedule(
    'pc6-reference-ingest-0400',
    '0-30/2 4 * * 2-6',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  -- Weekly scheme master, 03:00-03:28 UTC Tuesday.
  perform cron.unschedule('pc6-scheme-master-weekly')
  where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');
  perform cron.schedule(
    'pc6-scheme-master-weekly',
    '0-28/2 3 * * 2',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_scheme_master","jobKey":"pc6_amfi_scheme_master"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  raise notice '0205: production -- daily NAV every 2 min 03:30-04:30 UTC Tue-Sat (two jobs) and scheme master every 2 min 03:00-03:28 UTC Tue, all with a 300 s pg_net timeout.';
end $$;
