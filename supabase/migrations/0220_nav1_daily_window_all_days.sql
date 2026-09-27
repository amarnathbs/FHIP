-- NAV 1 -- PO decision #1 (27 Sep 2026), part 1 of 3: run the existing
-- budgeted/resumable daily-NAV collection window every day, including Sunday
-- and Monday.
--
-- WHY. NAV1 Production Final Certification (27 Sep 2026), F-17: AMFI
-- publishes Saturday/Sunday NAVs for roughly 600-700 liquid/overnight
-- schemes, but the daily window (0205: '30-58/2 3 * * 2-6' and
-- '0-30/2 4 * * 2-6') only ever ticks Tuesday-Saturday. NAVAll.txt carries
-- only each scheme's LATEST nav, so a weekend NAV the window never collected
-- is simply gone from the file by the next business-day tick -- there is no
-- way to recover it from the daily feed after the fact (the reconciliation
-- sweep, migration 0221/0222, and the one-off backfill both use the
-- date-ranged history endpoint instead, precisely because of this).
--
-- THE FIX. The day-of-week field changes from '2-6' (Tue-Sat) to '*' (every
-- day) on both halves of the window. Nothing else changes: same times, same
-- URL, same secret, same 300s pg_net timeout, same body. A Sunday or Monday
-- tick is not a special case in the application code -- runReferenceIngest()
-- already fetches, parses and writes whatever AMFI's file contains that
-- morning, whichever day it is; the day-of-week restriction was purely a
-- scheduling choice from before the weekend-gap problem was found. A call
-- that finds nothing new to write already responds 'skipped_unchanged_source'
-- in a few seconds (measured elsewhere in this programme), so a weekday
-- calendar's remaining 2-minute ticks on a weekend cost almost nothing.
--
-- SCHEME MASTER IS NOT CHANGED. Migration 0205's 'pc6-scheme-master-weekly'
-- stays Tuesday-only: PO decision #1 is scoped to daily NAV collection, and
-- scheme identity is near-static (a handful of launches a week against
-- 14,358) -- see 0188/0205's own header for that reasoning, unchanged here.
--
-- PRODUCTION ONLY, exactly like 0193/0194/0202/0205: acts only where
-- ii_nav_retention_policy has environment = 'production'. Elsewhere (DEV, a
-- fresh environment, PGlite) this migration does nothing and leaves the
-- scheme-master job (if present) exactly as it was.
--
-- Verification: scripts/nav1_0220_pglite_verification.mjs.

do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise notice '0220: not the production database -- the daily-NAV schedule is left untouched.';
    return;
  end if;

  -- Daily NAV, 03:30-03:58 UTC every day (was Tue-Sat only).
  perform cron.unschedule('pc6-reference-ingest')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
  perform cron.schedule(
    'pc6-reference-ingest',
    '30-58/2 3 * * *',
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

  -- Daily NAV, 04:00-04:30 UTC every day (was Tue-Sat only; same call, second half of the window).
  perform cron.unschedule('pc6-reference-ingest-0400')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest-0400');
  perform cron.schedule(
    'pc6-reference-ingest-0400',
    '0-30/2 4 * * *',
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

  raise notice '0220: production -- daily NAV window now runs every day (03:30-04:30 UTC, every 2 min). Scheme master stays Tuesday-only (unchanged).';
end $$;
