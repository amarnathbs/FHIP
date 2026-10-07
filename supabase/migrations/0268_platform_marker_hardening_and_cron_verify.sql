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
-- ---------------------------------------------------------------------------
-- PART B starts here: marker helper and the scheduled job verification report (service role only)
-- ---------------------------------------------------------------------------
-- premium_cron_verify(p_cron_secret_sha256) reports, one row per check, what the database can see about the
-- environment marker, the registered jobs, the Vault secret and the kill switches. Secrets are never
-- returned. To compare the Vault secret with the application CRON_SECRET the operator computes the SHA 256 of
-- CRON_SECRET on their own machine and passes the hex digest. The report says whether they match.

create or replace function public.platform_is_production()
returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.platform_deployment_environment where environment = 'production');
$fn$;
revoke all on function public.platform_is_production() from public, anon, authenticated;
grant execute on function public.platform_is_production() to service_role;

create or replace function public.premium_cron_verify(p_cron_secret_sha256 text default null)
returns table (check_name text, ok boolean, detail text)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_rows int;
  v_values text;
  v_prod boolean;
  v_jobs int;
  v_bad_jobs int;
  v_url_ok int;
  v_secret_n int;
  v_secret_sha text;
  v_enabled int;
begin
  select count(*), coalesce(string_agg(environment, ','), 'none') into v_rows, v_values from public.platform_deployment_environment;
  v_prod := public.platform_is_production();
  check_name := 'marker_single_row'; ok := v_rows <= 1; detail := 'rows: ' || v_rows::text || ', value: ' || v_values; return next;
  check_name := 'marker_value_allowed';
  ok := not exists (select 1 from public.platform_deployment_environment where environment not in ('production', 'development', 'staging'));
  detail := 'value: ' || v_values; return next;

  if to_regclass('cron.job') is null then
    check_name := 'cron_installed'; ok := false; detail := 'pg_cron is not installed in this database'; return next;
  else
    select count(*) into v_jobs from cron.job where jobname = 'premium-expiry-email-reminders';
    check_name := 'reminder_job_registered_only_in_production';
    ok := (v_prod and v_jobs = 1) or ((not v_prod) and v_jobs = 0);
    detail := 'production marker: ' || v_prod::text || ', jobs named premium-expiry-email-reminders: ' || v_jobs::text; return next;

    select count(*) into v_bad_jobs from cron.job where position('financialhealthplatform.com' in command) > 0;
    check_name := 'no_production_url_job_outside_production';
    ok := v_prod or v_bad_jobs = 0;
    detail := 'jobs whose command names the production origin: ' || v_bad_jobs::text; return next;

    select count(*) into v_url_ok from cron.job
     where jobname = 'premium-expiry-email-reminders'
       and position('https://app.financialhealthplatform.com/api/premium/cron/expiry-reminders' in command) > 0;
    check_name := 'reminder_job_url_is_the_production_route';
    ok := (not v_prod) or v_url_ok = 1;
    detail := 'job with the exact production route: ' || v_url_ok::text; return next;
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    check_name := 'vault_secret_present'; ok := false; detail := 'vault is not available in this database'; return next;
  else
    select count(*) into v_secret_n from vault.decrypted_secrets where name = 'premium_reminder_cron_secret';
    check_name := 'vault_secret_present'; ok := v_secret_n = 1; detail := 'secrets named premium_reminder_cron_secret: ' || v_secret_n::text; return next;
    if p_cron_secret_sha256 is not null then
      select encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex') into v_secret_sha
        from vault.decrypted_secrets where name = 'premium_reminder_cron_secret' limit 1;
      check_name := 'vault_secret_matches_application_cron_secret';
      ok := v_secret_sha is not null and v_secret_sha = lower(p_cron_secret_sha256);
      detail := case when ok then 'digest matches' else 'digest does not match, or no secret' end; return next;
    end if;
  end if;

  select count(*) into v_enabled from public.premium_reminder_job_control where enabled = true;
  check_name := 'all_kill_switches_off';
  ok := v_enabled = 0;
  detail := 'switches that are on: ' || v_enabled::text; return next;
end;
$fn$;
revoke all on function public.premium_cron_verify(text) from public, anon, authenticated;
grant execute on function public.premium_cron_verify(text) to service_role;
