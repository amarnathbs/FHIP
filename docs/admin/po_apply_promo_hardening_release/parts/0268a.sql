-- 0268 production marker hardening and scheduled job verification (part A of B)
-- =============================================================================
-- NEW migration on top of 0267. Nothing applied is edited. Item 10 of the hardening mission.
--
-- THE AUTHORITATIVE DEFINITION. platform_deployment_environment is created by migration 0228
-- (cron_purge_malware_sweep_url_capture). 0229 reads it and 0238 repeats an idempotent create. The
-- production marker row is operator DATA, inserted by hand once on the production project only.
--
-- FINDINGS FIXED HERE
--   * the table had no row level security and no revoke, so on a Supabase project the API roles could
--     have read it and, with the default table grants, written to it. Anyone able to add a production row
--     to DEV would make a later replay register production jobs there. Fixed: RLS on, all API role
--     privileges revoked (the migration role and the service role keep access).
--   * the environment value was free text. Fixed: a check constraint limits it to production, development
--     and staging. It is added NOT VALID so an unexpected existing value is reported, not hidden. Validate it
--     after reading the verify query output (README).
--   * more than one marker row was possible (two rows could disagree). Fixed: a unique index on a constant
--     expression allows at most one row. The migration stops with an error if more than one row exists now.
--
-- WHAT CANNOT BE PROVEN BY SQL (listed in the report): that the single marker row is truthful for this
-- project. The operator inserts it. premium_cron_verify() reports what it can see.
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A and B in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0268: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

create table if not exists public.platform_deployment_environment (
  environment text primary key,
  updated_at timestamptz not null default now()
);

alter table public.platform_deployment_environment enable row level security;
revoke all on public.platform_deployment_environment from anon, authenticated;

do $fn$
begin
  if (select count(*) from public.platform_deployment_environment) > 1 then
    raise exception 'MARKER_MORE_THAN_ONE_ROW' using errcode = 'P0001',
      detail = 'platform_deployment_environment must hold at most one row. Inspect it and keep the one that is true for this project.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_deployment_environment_value_check'
                  and conrelid = 'public.platform_deployment_environment'::regclass) then
    alter table public.platform_deployment_environment
      add constraint platform_deployment_environment_value_check
      check (environment in ('production', 'development', 'staging')) not valid;
  end if;
  create unique index if not exists uq_platform_deployment_environment_single
    on public.platform_deployment_environment ((true));
end $fn$;

comment on table public.platform_deployment_environment is
  'Per project environment marker, inserted by the operator and never by application code. At most one row (unique index), value limited to production, development or staging (check, validate after review). Read by migrations that must behave differently in production. Created by 0228, hardened by 0268.';
