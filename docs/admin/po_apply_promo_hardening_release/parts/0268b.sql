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
