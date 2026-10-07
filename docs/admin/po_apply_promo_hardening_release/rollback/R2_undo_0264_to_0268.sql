-- R2 rollback of 0264 to 0268: remove what they added, restore the two functions they replaced under the same signature
-- =============================================================================
-- Hand-run, ONE statement block at a time is fine. You normally do NOT need this file: the migrations are additive, and
-- redeploying the previous application release is enough to roll the application back (until the finalise step has been run).
-- Use it only to take a database back to its earlier shape, for example after a part failed on the way in.
--
-- BEFORE YOU RUN IT
--   * If 0279 was applied, run R1 first.
--   * Export these tables if they hold anything you want to keep: admin_monitoring_events, premium_entitlement_overrides,
--     promo_retention_runs, promo_email_circuit. They are dropped here.
--   * The guard below stops the file when some code exists only as a digest (created by the new release, or blanked by the
--     finalise). Dropping the digest columns would orphan those codes for good. Disable them and restore a backup instead.
--
-- WHAT IT KEEPS ON PURPOSE: the protective changes to platform_deployment_environment from 0268 (row level security on, no API
-- access, one row, allowed values). They are harmless to the old release and protect production. The code column stays nullable.
-- =============================================================================

do $fn$
begin
  if exists (select 1 from public.promo_codes where code is null and anonymised_at is null) then
    raise exception 'PROMO_ROLLBACK_BLOCKED' using errcode = 'P0001',
      detail = 'some promo codes exist only as a digest. Disable them and restore a backup instead of dropping the digest columns.';
  end if;
  if to_regprocedure('public.admin_list_promo_codes()') is null
     or to_regprocedure('public.redeem_promo_code_for_user(uuid,text,text,text)') is null
     or to_regprocedure('public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)') is null
     or to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text)') is null
     or to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)') is null then
    raise exception 'PROMO_ROLLBACK_BLOCKED' using errcode = 'P0001',
      detail = 'the old function shapes are missing. Run R1 first.';
  end if;
end $fn$;

-- the scheduled retention job and its switch
do $fn$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('promo-retention-cleanup') where exists (select 1 from cron.job where jobname = 'promo-retention-cleanup');
  end if;
end $fn$;
delete from public.premium_reminder_job_control where job_key = 'promo_retention';

-- new functions (0268, 0267, 0266, 0265, 0264)
drop function if exists public.premium_cron_verify(text);
drop function if exists public.platform_is_production();
drop function if exists public.promo_retention_run(boolean, timestamptz);
drop function if exists public.promo_retention_user_held(uuid, text);
drop function if exists public.promo_email_circuit_report(boolean);
drop function if exists public.promo_email_circuit_status();
drop function if exists public.admin_promo_email_request_status(text, text[]);
drop function if exists public.admin_promo_email_begin(text, int, boolean, text, text, uuid);
drop function if exists public.promo_email_limits();
drop function if exists public.promo_codes_backfill_record(uuid, int, int);
drop function if exists public.admin_promo_codes_hash_status();
drop function if exists public.promo_codes_finalise_hash_only(boolean);
drop function if exists public.promo_codes_digest_mark_verified(uuid, text);
drop function if exists public.promo_codes_digest_apply(uuid, text, int);
drop function if exists public.promo_codes_digest_pending(int);
drop function if exists public.admin_manage_premium_entitlement(text, uuid, date, text, boolean);
drop function if exists public.redeem_promo_code_for_user(uuid, text[], text, text, text);
drop function if exists public.admin_list_promo_codes_v2();
drop function if exists public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int);
drop function if exists public.promo_attempts_retention_days();

-- new tables
drop table if exists public.promo_retention_runs;
drop table if exists public.promo_retention_holds;
drop table if exists public.promo_retention_policy;
drop table if exists public.promo_email_circuit;
drop table if exists public.premium_entitlement_overrides;
drop table if exists public.admin_monitoring_events;

-- the two functions replaced under the same signature go back to their earlier text
create or replace function public.promo_code_events_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  raise exception 'promo_code_events is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;

create or replace function public.premium_reminder_claim(
  p_today date,
  p_thresholds int[],
  p_batch int default 50,
  p_max_attempts int default 3,
  p_retry_after_minutes int default 60,
  p_only_user uuid default null
)
returns table (
  ledger_id uuid, user_id uuid, email text, country text,
  entitlement_source text, ends_on date, threshold_days int, attempt int
)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_batch int := least(greatest(coalesce(p_batch, 50), 1), 500);
  v_new_count int;
  v_ids uuid[] := '{}';
begin
  if p_today is null or p_thresholds is null or coalesce(array_length(p_thresholds, 1), 0) = 0 then
    raise exception 'REMINDER_ARGUMENTS_INVALID' using errcode = '22023';
  end if;

  update public.premium_expiry_email_ledger l
     set status = 'unknown'
   where l.status = 'pending' and l.last_attempt_at < now() - interval '30 minutes'
     and (p_only_user is null or l.user_id = p_only_user);

  update public.premium_expiry_email_ledger l
     set status = 'void'
   where l.status = 'failed'
     and (p_only_user is null or l.user_id = p_only_user)
     and not exists (
       select 1 from public.user_entitlements e
        where e.user_id = l.user_id and e.entitlement_source = l.entitlement_source
          and e.plan_tier = 'premium' and e.effective_to = l.ends_on
          and e.effective_to >= p_today and (e.effective_from is null or e.effective_from <= p_today));

  with due as (
    select e.user_id, e.entitlement_source, e.effective_to as ends_on,
           (select min(x) from unnest(p_thresholds) x
             where (e.effective_to - p_today) <= x and (e.effective_to - coalesce(e.effective_from, p_today)) > x) as threshold
      from public.user_entitlements e
     where e.plan_tier = 'premium'
       and e.entitlement_source in ('admin_grant', 'promo_code')
       and e.effective_to is not null and e.effective_to >= p_today
       and (e.effective_from is null or e.effective_from <= p_today)
       and (p_only_user is null or e.user_id = p_only_user)
       and exists (select 1 from auth.users u where u.id = e.user_id and u.email is not null and btrim(u.email) <> '')
  ), ins as (
    insert into public.premium_expiry_email_ledger (user_id, entitlement_source, ends_on, threshold_days, status, attempts, last_attempt_at)
    select d.user_id, d.entitlement_source, d.ends_on, d.threshold, 'pending', 1, now()
      from due d
     where d.threshold is not null
       and not exists (select 1 from public.premium_expiry_email_ledger x
                        where x.user_id = d.user_id and x.entitlement_source = d.entitlement_source
                          and x.ends_on = d.ends_on and x.threshold_days = d.threshold)
     order by d.ends_on asc
     limit v_batch
    on conflict on constraint uq_premium_expiry_email_window do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from ins;
  v_new_count := coalesce(array_length(v_ids, 1), 0);

  with retry as (
    select l.id from public.premium_expiry_email_ledger l
     where l.status = 'failed' and l.attempts < p_max_attempts and l.next_attempt_at <= now()
       and (p_only_user is null or l.user_id = p_only_user)
       and exists (
         select 1 from public.user_entitlements e
          where e.user_id = l.user_id and e.entitlement_source = l.entitlement_source
            and e.plan_tier = 'premium' and e.effective_to = l.ends_on
            and e.effective_to >= p_today and (e.effective_from is null or e.effective_from <= p_today))
     order by l.next_attempt_at
     limit greatest(v_batch - v_new_count, 0)
     for update skip locked
  ), upd as (
    update public.premium_expiry_email_ledger l
       set status = 'pending', attempts = l.attempts + 1, last_attempt_at = now()
      from retry r where l.id = r.id
    returning l.id
  )
  select v_ids || coalesce(array_agg(id), '{}'::uuid[]) into v_ids from upd;

  return query
    select l.id, l.user_id, u.email::text, p.country_of_residence::text,
           l.entitlement_source, l.ends_on, l.threshold_days, l.attempts
      from public.premium_expiry_email_ledger l
      join auth.users u on u.id = l.user_id
      left join public.user_profiles p on p.user_id = l.user_id
     where l.id = any(v_ids)
     order by l.ends_on, l.id;
end;
$fn$;
revoke all on function public.premium_reminder_claim(date, int[], int, int, int, uuid) from public, anon, authenticated;
grant execute on function public.premium_reminder_claim(date, int[], int, int, int, uuid) to service_role;

-- new columns and what hangs on them
alter table public.promo_email_sends drop column if exists anonymised_at;
alter table public.promo_code_events drop column if exists anonymised_at;
drop index if exists public.idx_promo_email_requests_replaces;
drop index if exists public.idx_promo_email_requests_time;
alter table public.promo_email_requests drop column if exists replaces_promo_code_id;
alter table public.promo_email_requests drop column if exists kind;
alter table public.promo_email_requests drop column if exists purpose;
alter table public.promo_codes drop constraint if exists promo_codes_has_identity;
alter table public.promo_codes drop constraint if exists promo_codes_digest_shape;
drop index if exists public.uq_promo_codes_digest;
alter table public.promo_codes drop column if exists code_digest_verified_at;
alter table public.promo_codes drop column if exists code_digest_version;
alter table public.promo_codes drop column if exists code_digest;
alter table public.promo_codes drop column if exists anonymised_at;
-- the table grant as 0237 had it (the column grants of 0264 are removed by the revoke)
revoke select on public.promo_codes from anon, authenticated;
grant select on public.promo_codes to authenticated;
alter table public.user_entitlements drop constraint if exists user_entitlements_lifetime_units_check;
alter table public.user_entitlements drop column if exists admin_lifetime_grant_units;
drop function if exists public.is_entitlement_override_admin();
alter table public.admin_users drop column if exists can_override_entitlement_limits;
drop function if exists public.admin_list_monitoring_events(int);
drop function if exists public.promo_hardening_append_only();
drop function if exists public.premium_grant_lifetime_ceiling();
drop function if exists public.promo_normalise_email(text);
drop function if exists public.access_window_days(date, date);
drop function if exists public.access_end_date(date, int);
