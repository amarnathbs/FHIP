-- RENUMBERED 0128 -> 0135 during LR-2..LR-12 programme reconciliation
-- (2026-09-09): this file was originally allocated as 0128 on the
-- feature/lr-1-upload-security-lifecycle branch and applied to DEV under
-- that number (cron job id 4, confirmed live 2026-09-05) BEFORE LR-9/G5B/
-- LR-10/LR-11's own migrations (0129-0134) were allocated and applied to
-- production on a separate branch. Historical migrations are immutable and
-- production already has 0129-0134 applied, so this file is renumbered
-- forward to the next free slot for the merge into main -- exactly the same
-- reconciliation pattern already used for the FDH-3/R6 (0058) and App
-- Review (0031-0039) sibling-branch migration collisions. The file's SQL
-- CONTENT is unchanged from what DEV already ran under "0128" -- DEV's
-- already-created objects (the cron job, the vault secret, etc.) do not
-- need to be redone; only the filename/ledger-position changes for a fresh
-- migration chain built from main going forward. Any documentation still
-- referring to "migration 0128" (docs/financial-data-hub/
-- LR1_SCHEDULER_CLOSURE_MIGRATION_READY.md, scripts/lr1_scheduler_live_
-- autonomy_proof.mjs's own comments) is now describing this same file by
-- its old number -- harmless drift, not corrected retroactively, matching
-- this project's own established practice for prior renumbers.
--
-- LR-1 Scheduler Closure — activate the janitor as a genuine periodic
-- background sweep via Supabase's pg_cron + pg_net extensions, calling the
-- already-deployed, already-certified purge-sweep endpoint
-- (app/api/financial-data-hub/documents/cron/purge-sweep) on a fixed cadence.
--
-- BACKGROUND: `lib/financial-data-hub/services/purge.ts` and the purge-sweep
-- route have existed and been live-DEV certified since the LR-1 branch's own
-- Phase 4 pass (see docs/financial-data-hub/LR1_PHASE4_LIVE_DEV_CERTIFICATION.md),
-- but nothing in this codebase's deployment configuration ever invoked that
-- route on a cadence — the "janitor" was code-complete but dormant. This
-- migration is the Product Owner-authorised close of that gap:
--   - Hard-backstop threshold lowered 60 -> 50 minutes
--     (lib/financial-data-hub/constants/retention.ts, same commit).
--   - Janitor cadence: every 5 minutes.
--   - Designed worst case: 50 + 5 = 55 minutes (a genuine bound, not merely
--     the threshold constant's name — see that file's updated header).
--
-- PRECEDENT AND ITS DISCLOSED DEFECTS (deliberately NOT reproduced here):
-- the only other real scheduled job in this codebase,
-- `monthly-report-generation` (0010_module9_reports.sql), registers a
-- pg_cron + pg_net job with the identical shape this migration uses, but:
--   (a) hardcodes its target as `http://localhost:3000/...`, which
--       Supabase's hosted Postgres cannot reach from outside at all — the
--       job fires but the HTTP callback always fails; and
--   (b) hardcodes its `x-cron-secret` value as a plaintext literal directly
--       in the migration body, meaning the real secret has been sitting in
--       this repository's git history since 0010 was authored.
-- Neither defect is fixed here (out of scope for this migration — 0010 is
-- left untouched, per instruction), but this migration is deliberately
-- designed NOT to repeat either pattern:
--   (a) the target URL below is a real, non-localhost placeholder that must
--       be substituted with this project's actual reachable DEV endpoint
--       before this file is pasted into the DEV SQL Editor (see the
--       operator note directly above the `cron.schedule` call) — there is
--       no standing publicly-reachable DEV deployment of this app anywhere
--       in this project's history (every prior "live DEV" pass in this repo
--       used a developer's own local `next dev`, which Supabase Cloud
--       cannot reach), so a reachable DEV target (e.g. a tunnel, or a
--       temporary branch deploy pointed at the DEV Supabase project) is a
--       genuine, disclosed prerequisite this migration cannot manufacture.
--   (b) the secret is never embedded in this file at all — see below.
--
-- SECRET HANDLING: no secure secret-storage mechanism (Supabase Vault or
-- otherwise) exists anywhere in this codebase's prior migration history —
-- confirmed by searching every file under supabase/migrations for "vault"
-- (zero matches). Supabase Vault is introduced fresh, here, as the correct
-- fix, rather than reproducing 0010's plaintext-literal pattern. The actual
-- CRON_SECRET value is NEVER written into this file, into any migration,
-- or into git history — it is looked up at call time from
-- `vault.decrypted_secrets` by name. Before (or after) applying this
-- migration, a human operator must separately run, directly in the SQL
-- Editor (never committed to any file):
--
--   select vault.create_secret('<the real CRON_SECRET value>', 'lr1_purge_sweep_cron_secret');
--
-- If a secret with that name already exists, use
-- `select vault.update_secret(id, '<new value>') from vault.secrets where name = 'lr1_purge_sweep_cron_secret';`
-- instead. This is the identical CRON_SECRET value already deployed to this
-- app's own environment (`CRON_SECRET` in `.env.local` / Amplify env config)
-- — the purge-sweep route compares against that same value, so the Vault
-- copy must match it exactly, and must be re-run if that value ever rotates.
--
-- IDEMPOTENCY: replaying this migration must never produce two jobs.
-- `cron.unschedule(...)` runs first, guarded by an existence check (mirrors
-- 0010's own idempotent unschedule-then-reschedule pattern) — safe to paste
-- multiple times.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- supabase_vault is a genuine Supabase Cloud extension (present on both DEV
-- and production hosted Postgres) but is NOT available under PGlite, the
-- ephemeral in-memory Postgres this repo's own ai_insight_pack_* test suite
-- (tests/unit/aiInsightPack20HouseholdE2E.test.ts and its siblings) uses to
-- rebuild the ENTIRE migration chain from scratch for each certification
-- run — discovered when merging this migration into the LR-2..LR-12
-- programme's own ledger caused those tests to fail with "extension
-- 'supabase_vault' is not available" the moment 0135 entered a fresh-chain
-- rebuild for the first time. Unlike pg_cron/pg_net (which PGlite already
-- tolerates -- migration 0010 has created them since long before this file
-- existed, with no PGlite test ever failing on them), supabase_vault has no
-- such precedent anywhere in this ledger. Wrapped in an exception-swallowing
-- DO block so a real Supabase Cloud apply (DEV/production) still creates the
-- extension exactly as before (the exception handler only triggers on an
-- actual error), while a PGlite fresh-chain rebuild degrades gracefully
-- instead of aborting the whole chain. Nothing later in this migration
-- actually calls a vault.* function at APPLY time (the vault.create_secret()
-- call in this file's own header comment above is a manual, human-run
-- step; the vault.decrypted_secrets reference at line ~115 below is a
-- string handed to cron.schedule(), only evaluated when the cron job
-- itself fires, never at migration-apply time) — so this guard has nothing
-- else to protect.
do $$
begin
  create extension if not exists supabase_vault cascade;
exception
  when others then
    raise notice 'supabase_vault extension unavailable in this environment (expected under PGlite fresh-chain tests) -- unaffected on real Supabase Cloud DEV/production, where the extension is genuinely available.';
end $$;

select cron.unschedule('lr1-document-purge-sweep')
where exists (select 1 from cron.job where jobname = 'lr1-document-purge-sweep');

-- ---------------------------------------------------------------------------
-- OPERATOR ACTION REQUIRED before this job can succeed: replace the
-- placeholder URL below with this project's real, publicly reachable DEV
-- app origin (never localhost/127.0.0.1 — Supabase's hosted Postgres cannot
-- reach either). When this same migration is later applied to PRODUCTION,
-- change ONLY this one literal to
-- 'https://app.financialhealthplatform.com/api/financial-data-hub/documents/cron/purge-sweep'
-- — nothing else in this file differs between environments; the secret
-- lookup is environment-agnostic by construction (each Supabase project has
-- its own independent Vault store, so the same secret NAME resolves to that
-- project's own value automatically).
-- ---------------------------------------------------------------------------
select cron.schedule(
  'lr1-document-purge-sweep',
  '*/5 * * * *', -- every 5 minutes
  $$
  select net.http_post(
    url := '<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>/api/financial-data-hub/documents/cron/purge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lr1_purge_sweep_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
