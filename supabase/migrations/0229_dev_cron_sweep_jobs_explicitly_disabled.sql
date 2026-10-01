-- AIE-1 / LR-1 scheduler closure -- PO decision (2026-10-01): until a
-- separate DEV application deployment connected exclusively to DEV services
-- exists (target end-state, a PO/infra decision outside this migration's
-- power to execute -- no AWS/Amplify write access exists in this
-- environment), the DEV HTTP cron jobs for purge-sweep and malware-scan-sweep
-- must be explicitly DISABLED, not left broken-and-silently-failing, and the
-- gap must be documented rather than guessed at.
--
-- BACKGROUND. `lr1-document-purge-sweep` was originally applied to DEV under
-- its old migration number (0128, see 0135's own header) with the
-- `<REPLACE_WITH_REACHABLE_APP_ORIGIN>` placeholder from that era. No
-- reachable DEV application origin has ever existed in this project's
-- history (every prior "live DEV" verification pass in this repo used a
-- developer's own local `next dev`, which Supabase Cloud's pg_net cannot
-- reach) -- so whatever URL DEV's copy of that job currently holds is either
-- the inert placeholder literal or a long-stale, now-unreachable one-off
-- tunnel URL. Either way it is not doing anything useful, and per this
-- mission's own standing rule, under NO circumstance may DEV's cron ever be
-- pointed at PRODUCTION's real URL (createAdminClient() is env-pinned to
-- whichever Supabase project the deployed app build targets, not
-- request-selectable -- a DEV job calling the production route would
-- operate on PRODUCTION data). This environment's PostgREST-only DEV
-- credentials cannot read the `cron` schema, so the exact current stored
-- command for each DEV job could not be inspected before writing this file
-- (same limitation 0228 discloses for production) -- this migration does not
-- assume any particular current state, it just unconditionally clears all
-- four job names on DEV.
--
-- WHAT THIS DOES. Idempotent `cron.unschedule()`, guarded by existence
-- checks (same idiom as 0135/0149/0174/0228), for all four job names this
-- job family uses. A job name that does not exist on DEV is a no-op. Nothing
-- is re-scheduled -- DEV is left with no purge-sweep or malware-scan-sweep
-- cron jobs at all until the DEV-origin architecture decision above is made
-- and a fresh, correctly-guarded migration re-enables them against a real
-- reachable DEV origin.
--
-- SAFETY GUARD: this file is meant for DEV, but is written defensively in
-- case it is ever mistakenly applied to production -- it checks the SAME
-- `platform_deployment_environment` marker table 0228 introduces and
-- refuses to touch anything if a `production` row is present, so applying
-- this file to the wrong database fails safe (a no-op) rather than
-- disabling production's real, working sweeps. This is the mirror image of
-- 0228's own guard (0228 proceeds only WITH a production row; this proceeds
-- only WITHOUT one).
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not create a DEV-reachable app
-- origin (not this migration's power to do), does not change any feature
-- flag, and does not touch production in any way.
--
-- KNOWN GAP LEFT OPEN, NAMED EXPLICITLY: DEV has no automated
-- purge/malware-scan sweep at all after this migration. The documents/
-- statements this affects on DEV must be purged manually (or via the same
-- purge-sweep route invoked by hand, e.g. `curl` with the correct
-- `x-cron-secret`) until the DEV-origin decision is made. This is a
-- disclosed, accepted gap, not an oversight.

do $$
begin
  if exists (select 1 from platform_deployment_environment where environment = 'production') then
    raise notice '0229: production marker row present -- refusing to touch cron jobs (this migration is DEV-only, guarded to fail safe).';
    return;
  end if;

  perform cron.unschedule('lr1-document-purge-sweep')
  where exists (select 1 from cron.job where jobname = 'lr1-document-purge-sweep');

  perform cron.unschedule('aie1-document-purge-sweep')
  where exists (select 1 from cron.job where jobname = 'aie1-document-purge-sweep');

  perform cron.unschedule('fdh3-malware-scan-sweep')
  where exists (select 1 from cron.job where jobname = 'fdh3-malware-scan-sweep');

  perform cron.unschedule('aie1-malware-scan-sweep')
  where exists (select 1 from cron.job where jobname = 'aie1-malware-scan-sweep');

  raise notice '0229: not production -- purge-sweep/malware-scan-sweep cron jobs explicitly disabled (unscheduled where present). DEV has no automated sweep until a reachable DEV app origin exists and a follow-up migration re-enables them correctly.';
end $$;

-- ---------------------------------------------------------------------------
-- NOTE ON MIGRATION ORDER: this file depends on `platform_deployment_environment`
-- existing, which 0228 creates. Both files must be applied together, 0228
-- before 0229, on every environment (including DEV) -- applying 0229 alone
-- against a database that has never run 0228 will fail with an undefined
-- table error, which is the correct, loud failure mode (better than silently
-- assuming "not production").
-- ---------------------------------------------------------------------------
