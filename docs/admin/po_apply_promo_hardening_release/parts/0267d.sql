-- ---------------------------------------------------------------------------
-- PART D starts here: the scheduled job (production marker only, doing nothing while the switch is off)
-- ---------------------------------------------------------------------------
-- The job calls the SQL function directly (no web call, no secret). The function itself reads the job control
-- row, so a registered job with the row disabled is a cheap no-op that only records a skipped run. Absent
-- the pg_cron extension, or absent the production marker row (DEV, a fresh environment, PGlite), this
-- registers nothing.

do $fn$
begin
  if to_regclass('cron.job') is null then
    raise notice '0267: pg_cron is not installed here, the retention job is not registered.';
    return;
  end if;
  if not exists (select 1 from public.platform_deployment_environment where environment = 'production') then
    raise notice '0267: no production marker row here, the retention job is not registered.';
    return;
  end if;

  perform cron.unschedule('promo-retention-cleanup')
  where exists (select 1 from cron.job where jobname = 'promo-retention-cleanup');

  perform cron.schedule('promo-retention-cleanup', '43 3 * * *', $cron$ select public.promo_retention_run(false); $cron$);
  raise notice '0267: retention job registered (it does nothing until the promo_retention switch is enabled).';
end $fn$;
