-- NAV2 risk-free weekly refresh: the schedule with a SATURDAY retry window, for the job that now catches up missed auctions and e-mails an alert.
-- Replaces the schedule of 0319 (and of 0317). Safe whether 0319 was applied or not.
--
-- WHY. Product Owner decision 13-11-2026 (build both catch-up and e-mail alert). Two things in the job need a slightly different calendar.
--   1. CATCH-UP. Each call first works on the current weeks auction, and once that is done it works on an earlier auction that has no stored row
--      (within the last four weeks), one auction per three steps. More windows in the week means more chances to finish a late or missed one.
--   2. THE ALERT. A week that is still not loaded after the Friday windows is reported once, just before the LAST call of the Saturday window
--      (Saturday 03:44 UTC), so the Saturday window has to exist: it is the final retry before the alert.
--
--   nav2-risk-free-refresh-wed       Wednesday 15:30, 15:35, 15:40 and 15:45 UTC (21:00 to 21:15 India time), the evening of the weekly auction (unchanged)
--   nav2-risk-free-refresh-thu-sat   Thursday, Friday and Saturday 03:30, 03:35, 03:40 and 03:45 UTC (09:00 to 09:15 India time), retries and catch-up
--
-- The old job name nav2-risk-free-refresh-thu-fri (0319) is removed so that nothing keeps calling on the old calendar. The Wednesday job is
-- registered again with the same schedule. Nothing else changes: the same route, the same vault secret, the same four calls five minutes apart.
--
-- WHAT IT DOES NOT DO. It does not switch the job on and does not touch any stored rate. The kill switch row nav2_risk_free_weekly_refresh in
-- ii_reference_job_control stays as it is. The route also refuses anything that does not carry the shared cron secret.
--
-- PRODUCTION ONLY, ENFORCED. Like 0228 and 0319, nothing is registered unless this database carries the row environment = production in
-- platform_deployment_environment, so a DEV database or a from-scratch replay never schedules calls to the production app.
--
-- SECRET. Reuses the vault secret pc6_reference_ingest_cron_secret that 0187, 0188 and 0319 already use. Nothing is typed, created or rotated here.
--
-- EDITOR SAFETY. ASCII only. No bare dollar quote. No semicolon or quote inside a comment. No percent sign.
--
-- ROLLBACK: docs/nav2/po_apply_weekly_refresh/ROLLBACK_switch_off_and_unschedule.sql

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if not exists (select 1 from platform_deployment_environment where environment = 'production') then
    raise notice '0320: not the production database, the risk-free refresh schedule was NOT registered.';
    return;
  end if;

  perform cron.unschedule('nav2-risk-free-refresh-wed')
  where exists (select 1 from cron.job where jobname = 'nav2-risk-free-refresh-wed');

  perform cron.schedule(
    'nav2-risk-free-refresh-wed',
    '30,35,40,45 15 * * 3',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/nav2-risk-free-refresh',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := jsonb_build_object('dryRun', false),
      timeout_milliseconds := 40000
    );
    $cron$
  );

  perform cron.unschedule('nav2-risk-free-refresh-thu-fri')
  where exists (select 1 from cron.job where jobname = 'nav2-risk-free-refresh-thu-fri');

  perform cron.unschedule('nav2-risk-free-refresh-thu-sat')
  where exists (select 1 from cron.job where jobname = 'nav2-risk-free-refresh-thu-sat');

  perform cron.schedule(
    'nav2-risk-free-refresh-thu-sat',
    '30,35,40,45 3 * * 4,5,6',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/nav2-risk-free-refresh',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := jsonb_build_object('dryRun', false),
      timeout_milliseconds := 40000
    );
    $cron$
  );

  raise notice '0320: production, the risk-free refresh schedule was registered (Wednesday 15:30 to 15:45 UTC, Thursday Friday and Saturday 03:30 to 03:45 UTC).';
end
$do$;
