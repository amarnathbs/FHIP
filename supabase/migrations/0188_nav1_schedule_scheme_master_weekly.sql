-- NAV 1.23 (part 2) — schedule the AMFI scheme master WEEKLY.
--
-- WHY. Migration 0187 scheduled the daily NAV collection, which is what fills
-- ii_prices_nav. But NAV is only ever collected for instruments that already
-- exist in ii_instruments, and ii_instruments is populated by a DIFFERENT job
-- -- pc6_amfi_scheme_master -- which was equally unscheduled. Its last success
-- in production was 2026-09-20T11:23Z.
--
-- Left alone, that is a slow, silent coverage decay rather than a visible
-- failure: a newly launched scheme never enters ii_instruments, so the daily
-- NAV job never fetches a NAV for it, so nobody holding it sees a valuation.
-- Nothing errors. The only symptom is the fresh-NAV count drifting down
-- against a universe that is itself frozen -- as of 2026-09-24, 8,662 of
-- 14,357 active funds have a current NAV.
--
-- WHY WEEKLY AND NOT DAILY. Scheme identity is near-static: AMCs launch or
-- merge schemes on the order of a handful per week, against ~14,357 existing.
-- The source is the same NAVAll.txt the daily NAV job already fetches, so a
-- daily cadence would re-parse an essentially unchanged 5MB file 7x a week to
-- discover a few rows. Weekly is the honest match to how fast the underlying
-- data actually changes. If a launch-day gap ever matters commercially, the
-- fix is an on-demand run from the admin surface (which already exposes
-- exactly this job behind the same kill switch), not a faster cron.
--
-- CADENCE '0 3 * * 2' = 03:00 UTC Tuesday, deliberately 30 minutes BEFORE
-- 0187's '30 3 * * 2-6' daily NAV run. Ordering matters: refreshing the master
-- first means any scheme discovered this week gets a NAV on the same tick
-- rather than waiting a further day. 22 seconds is the observed runtime of a
-- real production scheme-master batch (2026-09-20T11:22:48 -> 11:23:10), so a
-- 30-minute lead is ample. The two jobs also carry different job_keys, and the
-- concurrency guard is per job_key, so neither can block the other even if one
-- overran.
--
-- SECRET. Reuses the SAME pc6_reference_ingest_cron_secret that 0187 created
-- by copying the already-proven sweep secret. Nothing is typed, created or
-- rotated here -- this migration only reads it. If 0187 has not been applied,
-- the schedule below is still registered but will authenticate with NULL and
-- 401, which is visible in net._http_response. Apply 0187 first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('pc6-scheme-master-weekly')
where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');

select cron.schedule(
  'pc6-scheme-master-weekly',
  '0 3 * * 2',
  $$
  select net.http_post(
    url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
    ),
    body := '{"sourceConfigId":"amfi_scheme_master","jobKey":"pc6_amfi_scheme_master"}'::jsonb
  );
  $$
);

-- NOT DONE HERE. The kill switch is untouched: pc6_amfi_scheme_master is
-- already enabled=true in production, so this takes effect at the next
-- Tuesday 03:00 UTC tick. To stop it, prefer the kill switch (PC6 runbook
-- section 5) over cron.unschedule -- it records WHY, and leaves the schedule
-- intact.
