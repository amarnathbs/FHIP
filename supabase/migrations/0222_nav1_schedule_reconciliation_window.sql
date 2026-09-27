-- NAV 1 -- PO decision #1 (27 Sep 2026), part 3 of 3: schedule the
-- reconciliation window.
--
-- THE SCHEDULE (UTC): 'pc6-nav-reconciliation', '0-16/2 10 * * *' --
-- 10:00-10:16 every 2 minutes, EVERY DAY, 9 calls. Chosen deliberately later
-- and SHORTER than the main window (03:30-04:30 UTC, 31 calls, 0205):
--   * later, so AMFI has had several extra hours past the 04:30 UTC cutoff to
--     publish anything it was going to publish that day (F-18's 67 late
--     schemes on 25 Sep are the exact case this exists to catch -- their
--     precise arrival time was never captured, so this is a documented,
--     disclosed buffer choice, not a proven all-clear cutoff);
--   * shorter, because navReconciliationSweep.ts's own coverage precheck
--     (see that file) skips the entire fetch-and-write path the moment
--     nothing is missing, so most days most of these 9 calls do nothing at
--     all once the first call confirms completeness -- the "SHORTER" the PO
--     asked for is enforced by the job's own logic, not merely a smaller
--     cron budget.
--
-- SAME URL, SECRET, TIMEOUT as 0205/0220: the route dispatches on jobKey, so
-- no new secret or endpoint is introduced. sourceConfigId defaults to
-- 'amfi_nav_daily' inside the route (see app/api/investment-intelligence/
-- cron/pc6-nav-reconciliation/route.ts) and publicationDate defaults to the
-- server clock's current UTC date -- "the current publication date", exactly
-- as the PO's brief asks, never a caller-supplied date in the scheduled body.
--
-- PRODUCTION ONLY, exactly like 0193/0194/0202/0205/0220: acts only where
-- ii_nav_retention_policy has environment = 'production'.
--
-- TO STOP. Prefer the kill switch (0221's job-control row), which records why
-- and leaves the schedule itself intact:
--   update ii_reference_job_control set enabled = false,
--     disabled_reason = '<why>', disabled_at = now()
--   where job_key = 'pc6_amfi_daily_nav_reconciliation';
--
-- Verification: scripts/nav1_0222_pglite_verification.mjs.

do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    perform cron.unschedule('pc6-nav-reconciliation')
    where exists (select 1 from cron.job where jobname = 'pc6-nav-reconciliation');
    raise notice '0222: not the production database -- nothing scheduled; any reconciliation job present was removed.';
    return;
  end if;

  perform cron.unschedule('pc6-nav-reconciliation')
  where exists (select 1 from cron.job where jobname = 'pc6-nav-reconciliation');
  perform cron.schedule(
    'pc6-nav-reconciliation',
    '0-16/2 10 * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-nav-reconciliation',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav_reconciliation"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  raise notice '0222: production -- reconciliation window scheduled every day, 10:00-10:16 UTC every 2 min (9 calls; most are no-ops once coverage is confirmed complete).';
end $$;
