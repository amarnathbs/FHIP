-- NAV 1 Stage D (D.9, final step) — schedule selective historical hydration
-- every 30 minutes, and switch it on. PO decision, 2026-09-24.
--
-- WHAT IT DOES. Every 30 minutes, asks the hydration route to fetch history
-- for any instrument a user holds whose history is not yet stored -- from
-- AMFI, with TIGZIG as fallback -- so a new user's funds get their history
-- within half an hour. With every held fund's history floor recorded, a
-- normal run finds nothing to do and finishes in well under a second; it only
-- does real work when a user brings a fund FHIP has no history for.
--
-- WHY IT IS SAFE TO RUN ON A SCHEDULE NOW (all proven 2026-09-24):
--   - per-request timeouts, so a hung provider cannot stall a run;
--   - fund-house codes stored (0191), so a run sends AMFI no probe burst;
--   - a block page can never become a history floor;
--   - each run claims itself (0192): a 'running' batch with per-instrument
--     progress, stale reconciliation, and no overlapping runs;
--   - a history floor per instrument (0190), so empty pre-launch windows are
--     never re-requested.
-- Server proof on production: a real run re-recorded a deleted floor
-- correctly in 15.4 s (the same fund took ~4.5 min before the fixes), wrote
-- no NAV rows, and closed its own batch.
--
-- PRODUCTION ONLY -- enforced, not just documented. This schedules calls to
-- the PRODUCTION app URL. Applied to DEV (or replayed from scratch), it must
-- do nothing, or DEV's scheduler would start triggering production runs. It
-- therefore acts only where ii_nav_retention_policy records
-- environment = 'production' (the per-environment row written at plan step
-- D.8), and otherwise raises a NOTICE and changes nothing. Anywhere without
-- that row -- DEV, a fresh environment, PGlite -- it is a no-op, so the
-- migration chain stays replayable.
--
-- CADENCE '*/30 * * * *'. maxInstruments 10 bounds any single run.
-- changeoverDate is passed explicitly, as the route requires: it is the NAV 1
-- policy date C (2026-09-21), never "today".
--
-- SECRET. Reads pc6_reference_ingest_cron_secret, created by 0187 as a byte
-- copy of the proven malware-sweep secret. Nothing is created or rotated here.
--
-- TIMEOUT. pg_net's default is 5 s; a run that does real work takes longer.
-- 30 s matches the gateway's own limit, so a run that finishes in time is
-- recorded as 200 in net._http_response. A longer run still completes on the
-- server and records its own batch -- the batch, not the HTTP status, is the
-- authoritative record.
--
-- TO STOP. Prefer the kill switch (it records why and leaves the schedule):
--   update ii_reference_job_control set enabled = false,
--     disabled_reason = '<why>', disabled_at = now()
--   where job_key = 'pc6_selective_historical_hydration';
-- A disabled run returns skipped_kill_switch without touching anything.

do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise notice '0193: not the production database (no ii_nav_retention_policy row with environment = ''production'') -- hydration schedule NOT registered and kill switch NOT changed.';
    return;
  end if;

  perform cron.unschedule('pc6-selective-hydration')
  where exists (select 1 from cron.job where jobname = 'pc6-selective-hydration');

  perform cron.schedule(
    'pc6-selective-hydration',
    '*/30 * * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-selective-hydration',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"changeoverDate":"2026-09-21","maxInstruments":10}'::jsonb,
      timeout_milliseconds := 30000
    );
    $cron$
  );

  update ii_reference_job_control
  set enabled = true,
      disabled_reason = null,
      disabled_by_admin_id = null,
      disabled_at = null
  where job_key = 'pc6_selective_historical_hydration';

  raise notice '0193: production -- hydration scheduled every 30 minutes and kill switch ENABLED.';
end $$;
