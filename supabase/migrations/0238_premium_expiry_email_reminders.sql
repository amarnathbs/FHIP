-- =============================================================================
-- 0238 — Premium expiry e-mail reminders (send-once ledger + scheduled job),
--         and a 30-day default for promo-code access length
-- =============================================================================
--
-- A NEW migration on top of 0237 (0237 has been handed to the PO to apply and is
-- NOT edited). 0231 is applied on DEV and production and is untouched.
--
-- 1. PROMO DEFAULT. A code's ACCESS LENGTH (duration_days) now defaults to 30 days
--    (one month) instead of 365; an admin may still set any 1..365. The code's
--    own REDEMPTION WINDOW is the separate expires_on field ("code can be redeemed
--    until"), so both readings of the PO's wording exist as separate admin fields:
--      * access length   = duration_days  (default 30, max 365)
--      * redemption window = expires_on   (a date, or explicit "no expiry")
--    admin_create_promo_code() is replaced in place (same signature; only the
--    default and one extra return key, ends_if_redeemed_today, change) and the
--    column default is moved to 30. Existing codes keep their stored duration.
--
-- 2. E-MAIL REMINDERS for ADMIN-GRANTED and PROMO Premium (never paid), to the
--    entitlement's own user only. Thresholds are one named list in application
--    code (lib/services/premiumExpiryReminderEmail.ts, default [30]); the
--    database receives them as a parameter, so there is a single source.
--    Everything is DISABLED BY DEFAULT and fails closed:
--      * premium_reminder_job_control row 'expiry_email' ships enabled = false;
--        the route reads it on every run and treats a missing row / read error /
--        anything but literal true as disabled;
--      * the pg_cron job is registered ONLY on a database that carries the
--        operator marker row platform_deployment_environment.environment =
--        'production' (so a DEV database never schedules a call to the production
--        origin; DEV registers nothing).
--
--    SEND-ONCE LEDGER premium_expiry_email_ledger. One row per
--    (user, entitlement source, end date, threshold) with a UNIQUE key, so a
--    rerun, a retry or an overlapping cron can never create a second row for the
--    same threshold of the same window. An extension changes the end date and so
--    opens a new window (a new reminder is legitimate); a re-run for the same
--    window is not.
--      claim  : premium_reminder_claim() inserts the new ledger rows with
--               ON CONFLICT DO NOTHING and returns ONLY the rows this call
--               inserted (plus failed rows it re-claims), so two overlapping runs
--               cannot both send the same message.
--      record : premium_reminder_record() moves a PENDING row to sent / failed /
--               abandoned; it cannot touch a row that is not pending, so a late
--               or duplicate record call can never flip a sent row.
--    Rules inside the claim:
--      * only source admin_grant / promo_code, plan premium, window current;
--        a paying customer (source payment) never qualifies, even with a grant in
--        reserve;
--      * a threshold t applies when days_left <= t AND the window is longer than
--        t days (a 30-day promo redeemed today is not told "30 days left");
--      * when several thresholds apply, only the MOST URGENT is sent (enabling
--        the job late never sends two e-mails at once);
--      * a failed send is retried at most p_max_attempts times with a delay, and
--        only while the entitlement is still the same window and still managed
--        (otherwise the row is voided);
--      * a row stuck 'pending' (worker died mid-send, outcome unknown) is marked
--        'unknown' after 30 minutes and is NEVER re-sent: at-most-once beats a
--        possible duplicate for an unknown outcome.
--    The ledger stores no e-mail address, no message body and no code value.
--
-- OPERATOR STEPS (the PO applies migrations; see the report for the full list):
--   * production only: insert into platform_deployment_environment (environment)
--       values ('production') on conflict do nothing;
--   * create the Vault secret named premium_reminder_cron_secret holding the
--       CRON_SECRET value (never written to a file), then re-run the schedule
--       block of this migration (idempotent) if the marker row was added later;
--   * enable only when ready:
--       update premium_reminder_job_control set enabled = true,
--         disabled_reason = null, updated_at = now() where job_key = 'expiry_email';
--
-- ROLLBACK (discards the ledger; export it first):
--   select cron.unschedule('premium-expiry-email-reminders')
--     where exists (select 1 from cron.job where jobname = 'premium-expiry-email-reminders');
--   drop function if exists public.premium_reminder_record(uuid,boolean,text,text,int,int);
--   drop function if exists public.premium_reminder_claim(date,int[],int,int,int,uuid);
--   drop table if exists public.premium_expiry_email_ledger, public.premium_reminder_job_control;
--   alter table public.promo_codes alter column duration_days set default 365;
--   (and re-run 0237's admin_create_promo_code definition to restore its 365 default)
--
-- MIGRATION NUMBER 0238: next free number above everything found on every ref and
-- every worktree at the time of writing (see the report).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Promo default access length: 30 days
-- ---------------------------------------------------------------------------
alter table public.promo_codes alter column duration_days set default 30;

create or replace function public.admin_create_promo_code(
  p_code text, p_duration_days int, p_max_redemptions int, p_unlimited boolean,
  p_expires_on date, p_no_expiry boolean, p_note text
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_today date := current_date;
  v_code text;
  v_duration int := coalesce(p_duration_days, 30);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
  v_hint text;
  v_try int := 0;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;

  if v_duration < 1 or v_duration > 365 then raise exception 'PROMO_DURATION_INVALID' using errcode = '22023'; end if;
  if coalesce(p_unlimited, false) then
    if p_max_redemptions is not null then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  else
    if p_max_redemptions is null or p_max_redemptions < 1 or p_max_redemptions > 1000000 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_no_expiry, false) then
    if p_expires_on is not null then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  else
    if p_expires_on is null or p_expires_on < v_today or p_expires_on > v_today + 3650 then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  end if;
  if v_note is not null and char_length(v_note) > 500 then raise exception 'PROMO_NOTE_INVALID' using errcode = '22023'; end if;

  if p_code is not null and btrim(p_code) <> '' then
    v_code := public.promo_normalise_code(p_code);
    if v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,24}$' then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  end if;

  loop
    v_try := v_try + 1;
    if v_code is null or v_try > 1 then
      if p_code is not null and btrim(p_code) <> '' then raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001'; end if;
      v_code := public.promo_generate_code();
    end if;
    v_hint := substr(v_code, 1, 2) || repeat('*', greatest(char_length(v_code) - 4, 2)) || substr(v_code, char_length(v_code) - 1, 2);
    begin
      insert into public.promo_codes (code, code_hint, duration_days, max_redemptions, expires_on, note, created_by)
      values (v_code, v_hint, v_duration, case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
              case when coalesce(p_no_expiry, false) then null else p_expires_on end, v_note, v_actor)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try >= 6 or (p_code is not null and btrim(p_code) <> '') then raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001'; end if;
    end;
  end loop;

  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('create', v_actor, v_id, v_hint, jsonb_build_object(
    'duration_days', v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'unlimited', coalesce(p_unlimited, false),
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end,
    'no_expiry', coalesce(p_no_expiry, false),
    'has_note', v_note is not null));

  return jsonb_build_object('id', v_id, 'code', v_code, 'code_hint', v_hint, 'duration_days', v_duration,
    'ends_if_redeemed_today', v_today + v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Environment marker (same definition as the sibling cron migrations; idempotent)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_deployment_environment (
  environment text primary key,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Kill switch (ships DISABLED)
-- ---------------------------------------------------------------------------
create table if not exists public.premium_reminder_job_control (
  job_key text primary key,
  enabled boolean not null default false,
  disabled_reason text,
  updated_at timestamptz not null default now()
);
alter table public.premium_reminder_job_control enable row level security;   -- no policies: service role only
revoke all on public.premium_reminder_job_control from anon, authenticated;

insert into public.premium_reminder_job_control (job_key, enabled, disabled_reason)
select 'expiry_email', false, 'Shipped disabled. Enable deliberately (see the migration header) once the e-mail sender is configured and the PO has approved.'
where not exists (select 1 from public.premium_reminder_job_control where job_key = 'expiry_email');

-- ---------------------------------------------------------------------------
-- 4. Send-once ledger
-- ---------------------------------------------------------------------------
create table if not exists public.premium_expiry_email_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement_source text not null check (entitlement_source in ('admin_grant', 'promo_code')),
  ends_on date not null,
  threshold_days int not null check (threshold_days between 1 and 365),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'abandoned', 'unknown', 'void')),
  attempts int not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  last_error text check (last_error is null or char_length(last_error) <= 200),
  created_at timestamptz not null default now(),
  -- THE SEND-ONCE KEY
  constraint uq_premium_expiry_email_window unique (user_id, entitlement_source, ends_on, threshold_days)
);
create index if not exists idx_premium_expiry_email_status on public.premium_expiry_email_ledger (status, next_attempt_at);
comment on table public.premium_expiry_email_ledger is
  'Premium expiry reminders: durable send-once ledger. One row per (user, source, end date, threshold). Holds no e-mail address, body or code value. Written only by premium_reminder_claim()/premium_reminder_record() (service_role).';
alter table public.premium_expiry_email_ledger enable row level security;   -- no policies: service role only
revoke all on public.premium_expiry_email_ledger from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Claim (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.premium_reminder_claim(
  p_today date,
  p_thresholds int[],
  p_batch int default 50,
  p_max_attempts int default 3,
  p_retry_after_minutes int default 60,
  p_only_user uuid default null          -- targeted/test runs only; the cron route never passes it
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

  -- Outcome unknown (worker died between send and record): never re-send.
  update public.premium_expiry_email_ledger l
     set status = 'unknown'
   where l.status = 'pending' and l.last_attempt_at < now() - interval '30 minutes'
     and (p_only_user is null or l.user_id = p_only_user);

  -- A failed row whose entitlement is no longer the same managed window is voided, not retried.
  update public.premium_expiry_email_ledger l
     set status = 'void'
   where l.status = 'failed'
     and (p_only_user is null or l.user_id = p_only_user)
     and not exists (
       select 1 from public.user_entitlements e
        where e.user_id = l.user_id and e.entitlement_source = l.entitlement_source
          and e.plan_tier = 'premium' and e.effective_to = l.ends_on
          and e.effective_to >= p_today and (e.effective_from is null or e.effective_from <= p_today));

  -- NEW reminders: only rows THIS call inserts are returned. Existing keys are excluded up front so
  -- already-sent windows never consume the batch; ON CONFLICT is the race-safe backstop.
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

  -- RETRIES of failed sends (bounded attempts, delayed), still-valid windows only.
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

-- ---------------------------------------------------------------------------
-- 6. Record (service_role only): only a PENDING row can be settled
-- ---------------------------------------------------------------------------
create or replace function public.premium_reminder_record(
  p_ledger_id uuid, p_ok boolean, p_message_id text, p_error text,
  p_retry_after_minutes int default 60, p_max_attempts int default 3
) returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare v_row public.premium_expiry_email_ledger%rowtype;
begin
  select * into v_row from public.premium_expiry_email_ledger where id = p_ledger_id for update;
  if not found or v_row.status <> 'pending' then return false; end if;
  if p_ok then
    update public.premium_expiry_email_ledger
       set status = 'sent', sent_at = now(), provider_message_id = left(p_message_id, 200), last_error = null
     where id = p_ledger_id;
  else
    update public.premium_expiry_email_ledger
       set status = case when v_row.attempts >= p_max_attempts then 'abandoned' else 'failed' end,
           last_error = left(coalesce(p_error, 'send failed'), 200),
           next_attempt_at = now() + make_interval(mins => greatest(coalesce(p_retry_after_minutes, 60), 1) * v_row.attempts)
     where id = p_ledger_id;
  end if;
  return true;
end;
$fn$;
revoke all on function public.premium_reminder_record(uuid, boolean, text, text, int, int) from public, anon, authenticated;
grant execute on function public.premium_reminder_record(uuid, boolean, text, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Schedule: PRODUCTION ONLY (enforced by the operator marker row)
-- ---------------------------------------------------------------------------
-- Hourly at minute 17. A run with the kill switch off is a cheap no-op. Retries of failed sends
-- happen on later runs within the bounded attempt budget. Absent the marker row (DEV, a fresh
-- environment, PGlite) this registers nothing, so DEV can never schedule a call to the production origin.
do $$
begin
  if not exists (select 1 from public.platform_deployment_environment where environment = 'production') then
    raise notice 'premium reminders: not the production database (no platform_deployment_environment row with environment = ''production'') -- cron job NOT registered.';
    return;
  end if;

  perform cron.unschedule('premium-expiry-email-reminders')
  where exists (select 1 from cron.job where jobname = 'premium-expiry-email-reminders');

  perform cron.schedule(
    'premium-expiry-email-reminders',
    '17 * * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/premium/cron/expiry-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'premium_reminder_cron_secret')
      ),
      body := '{}'::jsonb
    );
    $cron$
  );
  raise notice 'premium reminders: production -- cron job registered (disabled by the kill switch until enabled).';
end $$;
