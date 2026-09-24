-- NAV 1.23 — activate the DAILY NAV collection schedule in production.
--
-- WHY THIS EXISTS. `app/api/investment-intelligence/cron/pc6-reference-ingest`
-- has been complete, authenticated and kill-switched since PC6, and its own
-- header says "NOT SCHEDULED IN PRODUCTION ... a deferred human-present task".
-- Nothing ever invoked it on a schedule. Evidence from production on
-- 2026-09-24: `ii_reference_job_control.pc6_amfi_daily_nav` is enabled=true,
-- consecutive_failures=0, last_failure_at=null, last_success_at=
-- 2026-09-20T11:24Z. Zero failures plus a stale success timestamp is the
-- signature of a job that is not being CALLED, not one that is breaking.
-- `ii_prices_nav` consequently has no rows at all for 2026-09-21 onward --
-- the exact changeover date C the NAV 1 workbook set for "collect daily NAV
-- for EVERY live scheme going forward".
--
-- The job itself is not in question: the 2026-09-20T11:23 batch inserted
-- 14,341 rows (the full AMFI universe) and succeeded in 39 seconds.
--
-- SECRET HANDLING -- READ THIS BEFORE RUNNING. The value of CRON_SECRET is
-- never written into this file, any migration, or git history. Step 1 below
-- COPIES the already-proven secret that the malware-scan sweep has been
-- authenticating with since 2026-09-22 (confirmed 200s from both its jobs)
-- rather than asking anyone to paste CRON_SECRET again. That is deliberate:
-- the last hand-typed copy of this same value was truncated (39 chars pasted
-- against a 43-char secret) and produced silent 401s that looked like
-- "succeeded" in cron.job_run_details. Copying in SQL cannot truncate.
--
-- If `aie1_malware_scan_sweep_cron_secret` does not exist in this project's
-- Vault, step 1 creates NOTHING -- never an empty secret, never a job that
-- authenticates with ''. The schedule in step 2 is still registered; its
-- lazy secret lookup then yields NULL and every tick 401s, which is visible
-- in net._http_response. That is the same failure mode 0135/0149/0174
-- accept for a missing secret.
--
-- REPLAY SAFETY (amended 2026-09-24, same day as first application). The
-- first version RAISED when the source secret was missing, and read
-- vault.decrypted_secrets unconditionally. Both broke every fresh replay of
-- the migration chain -- PGlite verification scripts failed with `relation
-- "vault.decrypted_secrets" does not exist`, and a freshly bootstrapped
-- environment with no secret yet would have been unable to get past 0187 at
-- all. A migration chain must stay replayable; an operational secret is not
-- a schema prerequisite. The amendment matches 0174's established guard.
--
-- Production is unaffected: it already held the source secret when 0187 was
-- applied, so the amended block takes exactly the path the original took
-- there and produces the identical result.

-- ---------------------------------------------------------------------------
-- 1. Vault secret, copied from the proven one. Never re-typed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_source text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice
      '0187: vault.decrypted_secrets is unavailable in this environment (expected under '
      'PGlite fresh-chain replays) -- secret copy skipped; unaffected on real Supabase.';
    return;
  end if;

  select decrypted_secret into v_source
  from vault.decrypted_secrets
  where name = 'aie1_malware_scan_sweep_cron_secret';

  if v_source is null or length(v_source) = 0 then
    raise warning
      '0187: aie1_malware_scan_sweep_cron_secret is missing or empty in this project''s Vault. '
      'NOT creating pc6_reference_ingest_cron_secret (never an empty secret). The schedule is '
      'still registered and will 401 visibly in net._http_response until the secret exists; '
      're-run this migration once it does.';
    return;
  end if;

  if exists (select 1 from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret') then
    -- Idempotent re-run: refresh rather than duplicate.
    perform vault.update_secret(
      (select id from vault.secrets where name = 'pc6_reference_ingest_cron_secret'),
      v_source
    );
  else
    perform vault.create_secret(v_source, 'pc6_reference_ingest_cron_secret');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The schedule itself.
--
-- CADENCE '30 3 * * 2-6' is the runbook's own recommendation, unchanged:
-- 03:30 UTC Tuesday-Saturday = 09:00 IST, after AMFI's ~23:00 IST publication
-- for the preceding business day. Tue-Sat in UTC covers Mon-Fri IST
-- publications; it deliberately does not run on Sun/Mon UTC, when AMFI has
-- published nothing new. (Production data agrees: 2026-09-19 and 09-20 -- the
-- weekend -- hold 88 and 706 rows against ~5,850 on each weekday.)
--
-- The job posts an EMPTY-ish body naming the source and job key explicitly
-- rather than relying on route defaults, so reading `cron.job` tells you what
-- it actually does without also reading the route.
--
-- asOfDate is deliberately NOT pinned here: the route defaults it to the
-- invocation date, which is what a daily job wants. Pinning it in the cron
-- body would freeze every future run to one date.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('pc6-reference-ingest')
where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');

select cron.schedule(
  'pc6-reference-ingest',
  '30 3 * * 2-6',
  $$
  select net.http_post(
    url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
    ),
    body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb
  );
  $$
);

-- ---------------------------------------------------------------------------
-- 3. NOT DONE HERE, deliberately.
--
--   * The kill switch is left exactly as it is. `pc6_amfi_daily_nav` is
--     already enabled=true in production, so this schedule takes effect at the
--     next 03:30 UTC Tue-Sat tick. To stop it, prefer the kill switch
--     (runbook section 5) over cron.unschedule -- it records WHY.
--   * `pc6_amfi_scheme_master` is NOT scheduled here. It shares the same route
--     and last succeeded alongside the NAV run on 2026-09-20. Without it, a
--     newly-launched scheme never enters ii_instruments and so never gets a
--     daily NAV. That is a real gap, but it is a separate cadence decision
--     (weekly is the obvious candidate, not daily) and is left for an explicit
--     choice rather than bundled in silently.
--   * `pc6_selective_historical_hydration` stays enabled=false. This migration
--     activates DAILY collection only. Historical hydration is NAV 1's Stage D
--     and has its own runbook section (9b).
--   * The 2026-09-21..24 gap is NOT backfilled here. A migration is the wrong
--     place for a one-off data fetch; the operator steps are in the handover
--     note accompanying this file, using the already-enabled
--     `amfi_nav_history` source with an explicit fromDate/toDate.
-- ---------------------------------------------------------------------------
