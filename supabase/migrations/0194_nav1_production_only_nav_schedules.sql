-- NAV 1 — make the 0187/0188 NAV schedules production-only, like 0193.
--
-- THE PROBLEM. 0187 (daily NAV, 03:30 UTC Tue-Sat) and 0188 (weekly scheme
-- master, 03:00 UTC Tue) register pg_cron jobs that POST to the PRODUCTION app
-- URL, with no environment check. Both were applied to production only, so
-- nothing is wrong today. But replaying the migration chain onto DEV -- or
-- building any new environment from it -- would register those jobs there,
-- and that environment's scheduler would start triggering PRODUCTION ingest
-- runs. 0193 (hydration) was written with a production-only guard from the
-- start; this brings the two earlier schedules into line.
--
-- WHAT IT DOES. Uses the same marker as 0193: the per-environment row in
-- ii_nav_retention_policy (plan step D.8).
--   * environment = 'production'  -> keeps both jobs; changes nothing.
--   * anything else, or no row    -> removes both jobs if present.
-- On a fresh replay, 0187/0188 register their jobs moments earlier and this
-- removes them, so a non-production database ends with no job that calls
-- production. Where the jobs were never registered, it is a no-op.
--
-- WHY A NEW MIGRATION, not an edit to 0187/0188: both are already applied in
-- production, and a follow-up covers every case -- fresh replays, DEV, and
-- any environment where they might already have been applied.
--
-- REBUILDING PRODUCTION FROM SCRATCH (e.g. disaster recovery by replay). The
-- policy row is operator data, not a migration, so during such a replay it
-- does not exist yet: this migration then removes the 0187/0188 jobs and
-- 0193 skips hydration. That fails SAFE -- no scheduled calls rather than
-- wrong ones -- but the schedules must then be restored deliberately:
--   1. insert the production ii_nav_retention_policy row (plan step D.8 SQL);
--   2. re-apply 0187, 0188 and 0193 (each is idempotent).
-- Restoring from a database BACKUP needs none of this: the jobs and the row
-- come back together.

do $$
begin
  if exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise notice '0194: production -- the 0187/0188 NAV schedules are kept.';
    return;
  end if;

  perform cron.unschedule('pc6-reference-ingest')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');

  perform cron.unschedule('pc6-scheme-master-weekly')
  where exists (select 1 from cron.job where jobname = 'pc6-scheme-master-weekly');

  raise notice '0194: not the production database -- removed the 0187/0188 NAV schedules (which call the PRODUCTION app URL) where present.';
end $$;
