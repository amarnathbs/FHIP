-- NAV2 risk-free weekly refresh: register the schedule for the THREE-STEP job (replaces the schedule that 0317 would register).
--
-- WHY A NEW FILE. 0317 registered one call per run. The first real production dry run (09-11-2026) answered HTTP 504: Amplify ends every
-- request at 28 seconds and one call cannot read RBI politely inside that. The route now does ONE of three short steps per call (listing,
-- then release, then decide) and keeps what it read in ii_risk_free_refresh_stage (migration 0318, apply it first). So each window below calls
-- the route four times, five minutes apart: three calls do the three steps and the fourth is a spare that retries a step that hit a slow answer.
-- A call that finds the week already done makes no request to RBI. 0317 was never applied anywhere. If it was, this file replaces its two jobs
-- (same job names) so nothing keeps calling the old way.
--
--   nav2-risk-free-refresh-wed       Wednesday 15:30, 15:35, 15:40 and 15:45 UTC (21:00 to 21:15 India time), the evening of the weekly auction
--   nav2-risk-free-refresh-thu-fri   Thursday and Friday 03:30, 03:35, 03:40 and 03:45 UTC (09:00 to 09:15 India time), retries for a late release
--
-- WHAT IT DOES NOT DO. It does not switch the job on. The kill switch row nav2_risk_free_weekly_refresh in ii_reference_job_control stays as
-- it is. While the switch is off the route makes no request to RBI and writes nothing, so registering the schedule first is harmless. The route
-- also refuses anything that does not carry the shared cron secret.
--
-- PRODUCTION ONLY, ENFORCED. Like 0228, nothing is registered unless this database carries the row environment = production in
-- platform_deployment_environment. Without that row this file is a no-op, so a DEV database or a from-scratch replay never schedules calls
-- to the production app.
--
-- SECRET. Reuses the vault secret pc6_reference_ingest_cron_secret that 0187 and 0188 already use. Nothing is typed, created or rotated here.
--
-- EDITOR SAFETY. ASCII only. No bare dollar quote. No semicolon or quote inside a comment. No percent sign.
--
-- ROLLBACK: docs/nav2/po_apply_weekly_refresh/ROLLBACK_switch_off_and_unschedule.sql

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if not exists (select 1 from platform_deployment_environment where environment = 'production') then
    raise notice '0319: not the production database, the risk-free refresh schedule was NOT registered.';
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

  perform cron.schedule(
    'nav2-risk-free-refresh-thu-fri',
    '30,35,40,45 3 * * 4,5',
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

  raise notice '0319: production, the risk-free refresh schedule was registered (Wednesday 15:30 to 15:45 UTC, Thursday and Friday 03:30 to 03:45 UTC).';
end
$do$;
