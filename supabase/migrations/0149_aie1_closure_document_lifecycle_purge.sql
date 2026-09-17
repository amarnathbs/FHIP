-- AIE-1 closure mission (section 4/9) — temporary document lifecycle: purge
-- tracking columns on `aie_document_intake`, plus a scheduled sweep,
-- reusing the EXACT pattern LR-1's own janitor already established for FDH
-- (`0135_lr1_document_purge_sweep_scheduler.sql`,
-- `lib/financial-data-hub/services/purge.ts`) rather than inventing a
-- second retention mechanism. AIE never had a retention/purge job at all
-- before this migration (confirmed: no caller anywhere of
-- `lib/aie/storage.ts#deleteFromQuarantine`, and `aie_document_intake`'s
-- 'deleted' status was reachable in the state machine but nothing drove a
-- row to it).
--
-- COLUMN NAMING mirrors `fdh_statement_uploads`'s own
-- `raw_document_purge_*` columns exactly (same vocabulary, same states) so
-- a future reader who already knows FDH's purge model does not have to
-- learn a second one for AIE.
--
-- WHAT THIS DOES NOT DO: it does not touch `fdh_statement_uploads` or any
-- other module's purge state, and it does not change `aie_document_intake`'s
-- existing state-machine transitions (`ready -> deleted` was already a
-- legal edge in `lib/aie/stateMachine.ts` before this migration — that file
-- needs no DB change, only application code that actually calls it, which
-- this closure mission adds separately in `lib/aie/services/purge.ts` and
-- the three intake routes' own immediate-deletion call).
--
-- OPERATOR ACTION REQUIRED (same disclosed constraint as 0135): this
-- session has NO DDL execution channel against the real DEV/production
-- Supabase Postgres instance (confirmed by probing every known exec_sql/
-- execute_sql/run_sql/admin_exec RPC name — all return PGRST202, "not
-- found in the schema cache" — the same result the LR-1/AIE-1.1 live-DEV
-- passes already documented). This migration is written, reviewed and
-- ready, but NOT applied anywhere by this closure mission. A human
-- operator must paste it into the DEV (and, separately, production —
-- outside this mission's authority) SQL Editor.

alter table aie_document_intake
  add column if not exists purge_status text not null default 'not_required'
    check (purge_status in ('not_required', 'pending', 'in_progress', 'purged', 'failed')),
  add column if not exists purge_due_at timestamptz,
  add column if not exists purged_at timestamptz,
  add column if not exists purge_reason text,
  add column if not exists purge_attempt_count int not null default 0 check (purge_attempt_count >= 0),
  add column if not exists last_purge_error_sanitised text;

alter table aie_document_intake
  add constraint chk_aie_intake_purged_status
    check (purge_status <> 'purged' or status = 'deleted') not valid;
alter table aie_document_intake validate constraint chk_aie_intake_purged_status;

alter table aie_document_intake
  add constraint chk_aie_intake_purged_at
    check (purged_at is null or purge_status = 'purged') not valid;
alter table aie_document_intake validate constraint chk_aie_intake_purged_at;

-- Purge sweeps run over due, unpurged intakes only — partial index keeps it
-- small, mirroring `idx_fdh_uploads_purge_due` exactly.
create index if not exists idx_aie_intake_purge_due
  on aie_document_intake (purge_due_at)
  where purge_status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- pg_cron scheduler — mission section 4.2's "cleanup backstop: every 15
-- minutes" (deliberately less frequent than LR-1's 5-minute cadence: AIE's
-- primary path is IMMEDIATE deletion right after each pipeline run, not
-- reliance on the sweep — the sweep exists only to catch what immediate
-- deletion missed: a worker crash mid-pipeline, a transient storage-delete
-- failure, or a document abandoned before any run was ever created).
-- Same secret-handling discipline as 0135: the CRON_SECRET value is never
-- written into this file or any migration. Before applying, a human
-- operator runs, directly in the SQL Editor (never committed):
--
--   select vault.create_secret('<the real CRON_SECRET value>', 'aie1_purge_sweep_cron_secret');
--
-- (A SEPARATE vault secret NAME from LR-1's `lr1_purge_sweep_cron_secret`,
-- even though today both would hold the identical CRON_SECRET value — kept
-- distinct so AIE's own cron job can be rotated/disabled independently of
-- FDH's, without assuming the two will always share one secret.)
-- ---------------------------------------------------------------------------

do $$
begin
  create extension if not exists supabase_vault cascade;
exception
  when others then
    raise notice 'supabase_vault extension unavailable in this environment (expected under PGlite fresh-chain tests) -- unaffected on real Supabase Cloud DEV/production.';
end $$;

select cron.unschedule('aie1-document-purge-sweep')
where exists (select 1 from cron.job where jobname = 'aie1-document-purge-sweep');

-- ---------------------------------------------------------------------------
-- OPERATOR ACTION REQUIRED before this job can succeed: replace the
-- placeholder URL below with this project's real, publicly reachable DEV
-- app origin (never localhost — Supabase's hosted Postgres cannot reach
-- it). AIE is not merged to `main`/deployed yet (this mission grants no
-- merge/deploy authority), so this job will fire and receive 404s from a
-- reachable-but-not-yet-deployed origin until that separate authorisation
-- happens -- harmless (net.http_post failures are logged by pg_net, not
-- fatal), and expected.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'aie1-document-purge-sweep',
  '*/15 * * * *', -- every 15 minutes (mission section 4.2 default)
  $$
  select net.http_post(
    url := '<REPLACE_WITH_REACHABLE_APP_ORIGIN>/api/aie/cron/purge-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aie1_purge_sweep_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
