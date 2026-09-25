-- NAV 1 completion (2026-09-25) -- give the production daily-NAV and weekly
-- scheme-master schedules an explicit pg_net timeout (0193 already sets one
-- for hydration); without one, pg_net hangs up after 5 s.
--
-- FOUND LIVE, first scheduled daily tick, 25 Sep 2026 03:30 UTC (read-only
-- observation of production):
--   03:30:01.68  daily_nav batch opened (status 'running')
--   03:30:01.70  AMFI NAVAll.txt fetched and parsed (1,522,938 bytes)
--   03:30:06.12  last write: the batch's 17 rejection rows
--   after that   nothing -- no 24 Sep NAV row, batch still 'running' 17+
--                minutes later, pc6_amfi_daily_nav.last_success_at not advanced.
-- 0187 and 0188 call net.http_post WITHOUT timeout_milliseconds, and pg_net's
-- default is 5 s. The request was dropped ~5 s after it was sent, and the run
-- stopped at the same moment: the platform ends the request handler when the
-- caller disconnects. (0193's header assumed a longer run "still completes on
-- the server"; this tick is evidence that it does not.)
--
-- THE FIX. Re-register both jobs, same names, schedules, URL, secret and body,
-- plus `timeout_milliseconds := 300000` (5 min), so pg_net is never the party
-- that hangs up first. This removes the observed failure. It does NOT prove
-- the run fits: manual DEV daily runs took ~55 s (20 Sep), and whether the
-- hosting platform lets a request run past its ~30 s gateway limit is
-- unproven (0193 found a hydration run that continued after a 504; this tick
-- found a run that stopped on disconnect). If the next tick (26 Sep 03:30)
-- still does not close its batch, the ingest must be restructured into
-- bounded chunks or moved off the request path -- no pg_net setting can fix
-- a platform limit.
--
-- PRODUCTION ONLY, exactly like 0193/0194: on any database without a
-- production ii_nav_retention_policy row nothing is scheduled, and any stray
-- copy of these two jobs is removed (they call the production URL).
--
-- Verification: scripts/nav1_0202_pglite_verification.mjs.

do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    perform cron.unschedule('pc6-reference-ingest')
    where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
    perform cron.unschedule('pc6-scheme-master-weekly')
    where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');
    raise notice '0202: not the production database -- nothing scheduled; any 0187/0188 NAV job present was removed.';
    return;
  end if;

  perform cron.unschedule('pc6-reference-ingest')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
  perform cron.schedule(
    'pc6-reference-ingest',
    '30 3 * * 2-6',
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

  perform cron.unschedule('pc6-scheme-master-weekly')
  where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');
  perform cron.schedule(
    'pc6-scheme-master-weekly',
    '0 3 * * 2',
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
  raise notice '0202: production -- pc6-reference-ingest and pc6-scheme-master-weekly re-registered with a 300 s pg_net timeout.';
end $$;
