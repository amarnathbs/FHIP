-- =============================================================================
-- 0242 — E-mailing a promo code from the admin console (idempotent send ledger,
--         optional address binding)
-- =============================================================================
--
-- NEW migration on top of 0241. 0231, 0237 and 0238 are APPLIED and are NOT edited:
-- every change to an object they created is a DROP-and-recreate / CREATE OR REPLACE here.
-- No CHECK constraint on an existing table is dropped or recreated (the promo audit table's
-- event_type list is untouched: the dispatch audit is the recipient COUNT and a bound flag
-- inside the existing 'create' event's details, plus the ledger below).
--
-- WHAT THIS ADDS
--   1. promo_codes.bound_email_hash — a KEYED hash (HMAC-SHA256, computed by the application with a
--      server-side secret) of the one e-mail address allowed to redeem the code. NEVER the plain
--      address. NULL = the code is not bound. A bound code is single-use by construction (CHECK).
--   2. admin_create_promo_code(): new optional params p_bound_email_hash and p_recipient_count (the
--      audit records the COUNT and whether it is bound; never an address and never the code). The
--      old 7-argument call shape still works (the new params default).
--   3. redeem_promo_code_for_user(): new optional p_email_hash. A bound code redeemed by any account
--      whose hash does not match returns the SAME generic PROMO_CODE_UNUSABLE verdict ("This code
--      cannot be used.") through the same code path as a missing/expired/exhausted code. The
--      old 3-argument call shape still works.
--   4. admin_list_promo_codes(): returns an extra `bound` flag (the list shows that a code is bound
--      without exposing the hash).
--   5. Idempotency + send ledger (promo_email_requests, promo_email_sends): one request row per
--      (admin, request key) — a double-click, retry or concurrent resubmission cannot create a
--      second code or send a second e-mail; one ledger row per (admin, request key, code,
--      recipient keyed hash) with status sent / failed / abandoned and the attempt count. The
--      ledger holds NO address, NO body and NO code value. admin_promo_email_begin() also enforces a
--      per-admin rate limit (10 requests and 100 recipients per rolling hour).
--
-- THE CODE VALUE IS NOT STORED OR LOGGED BY ANY OF THIS. (The pre-existing promo_codes.code column
-- and admin_list_promo_codes() already carry the plain code for promo-code admins — that is the
-- 0237 design and is unchanged here; see the report.)
--
-- DEPLOY ORDER SAFETY: the application falls back to the old call shapes and refuses to send (and,
-- when binding is requested, refuses to create) if this migration is absent.
--
-- ROLLBACK (discards the send ledger; export it first):
--   drop function if exists public.admin_promo_email_record(text,uuid,text,text,int,text,text);
--   drop function if exists public.admin_promo_email_begin(text,int,boolean);
--   drop table if exists public.promo_email_sends, public.promo_email_requests;
--   (then re-run the original admin_create_promo_code / admin_list_promo_codes / redeem_promo_code_for_user
--    definitions from 0238 / 0237 after dropping the new-signature versions, and drop column bound_email_hash)
--
-- MIGRATION NUMBER 0242: next free number above everything found on every ref and every worktree
-- (highest found: 0241).
-- =============================================================================

-- 1. Address binding column (keyed hash only)
alter table public.promo_codes add column if not exists bound_email_hash text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_bound_hash_shape' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_bound_hash_shape
      check (bound_email_hash is null or bound_email_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_bound_single_use' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_bound_single_use
      check (bound_email_hash is null or (max_redemptions is not null and max_redemptions = 1));
  end if;
end $$;
comment on column public.promo_codes.bound_email_hash is
  'E-mailed codes (0242): HMAC-SHA256 (server-side secret) of the one normalised e-mail address allowed to redeem this code. Never the plain address. NULL = unbound. A bound code is single-use.';

-- 2. create (new signature) — drop the old one first
drop function if exists public.admin_create_promo_code(text, int, int, boolean, date, boolean, text);
create or replace function public.admin_create_promo_code(
  p_code text, p_duration_days int, p_max_redemptions int, p_unlimited boolean,
  p_expires_on date, p_no_expiry boolean, p_note text,
  p_bound_email_hash text default null, p_recipient_count int default 0
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
  -- An address-bound code is single-use by construction (one recipient, one redemption).
  if p_bound_email_hash is not null then
    if p_bound_email_hash !~ '^[0-9a-f]{64}$' then raise exception 'PROMO_BINDING_INVALID' using errcode = '22023'; end if;
    if coalesce(p_unlimited, false) or p_max_redemptions is distinct from 1 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_recipient_count, 0) < 0 or coalesce(p_recipient_count, 0) > 20 then raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023'; end if;

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
      insert into public.promo_codes (code, code_hint, duration_days, max_redemptions, expires_on, note, created_by, bound_email_hash)
      values (v_code, v_hint, v_duration, case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
              case when coalesce(p_no_expiry, false) then null else p_expires_on end, v_note, v_actor, p_bound_email_hash)
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
    'has_note', v_note is not null,
    -- e-mail dispatch audit: a COUNT and a flag only. Never an address, never the code.
    'recipient_count', coalesce(p_recipient_count, 0),
    'bound', p_bound_email_hash is not null));

  return jsonb_build_object('id', v_id, 'code', v_code, 'code_hint', v_hint, 'duration_days', v_duration,
    'bound', p_bound_email_hash is not null,
    'ends_if_redeemed_today', v_today + v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end);
end;
$fn$;

revoke all on function public.admin_create_promo_code(text, int, int, boolean, date, boolean, text, text, int) from public, anon;
grant execute on function public.admin_create_promo_code(text, int, int, boolean, date, boolean, text, text, int) to authenticated;

-- 3. redeem (new signature) — service_role only, as before
drop function if exists public.redeem_promo_code_for_user(uuid, text, text);
create or replace function public.redeem_promo_code_for_user(p_user_id uuid, p_code text, p_ip_hash text, p_email_hash text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_norm text := public.promo_normalise_code(p_code);
  v_row public.user_entitlements%rowtype;
  v_promo public.promo_codes%rowtype;
  v_found boolean;
  v_attempt uuid;
  v_user_attempts int;
  v_ip_attempts int;
  v_active_premium boolean;
  v_paid_active boolean;
  v_managed_active boolean;
  v_end date;
  v_from date;
begin
  if p_user_id is null then raise exception 'PROMO_USER_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'PROMO_USER_NOT_FOUND' using errcode = 'P0002'; end if;

  delete from public.promo_redemption_attempts where attempted_at < now() - interval '2 days';

  select count(*) into v_user_attempts from public.promo_redemption_attempts
   where user_id = p_user_id and attempted_at > now() - interval '15 minutes';
  v_ip_attempts := 0;
  if p_ip_hash is not null then
    select count(*) into v_ip_attempts from public.promo_redemption_attempts
     where ip_hash = p_ip_hash and attempted_at > now() - interval '15 minutes';
  end if;
  insert into public.promo_redemption_attempts (user_id, ip_hash) values (p_user_id, p_ip_hash) returning id into v_attempt;
  if v_user_attempts >= 10 or v_ip_attempts >= 30 then
    return jsonb_build_object('ok', false, 'code', 'PROMO_RATE_LIMITED');
  end if;

  -- Lock order: the user's entitlement row first, then the promo row.
  insert into public.user_entitlements (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements where user_id = p_user_id for update;
  v_active_premium := v_row.plan_tier = 'premium'
    and (v_row.effective_from is null or v_row.effective_from <= v_today)
    and (v_row.effective_to is null or v_row.effective_to >= v_today);
  v_paid_active := v_active_premium and v_row.entitlement_source = 'payment';
  v_managed_active := v_active_premium and v_row.entitlement_source in ('admin_grant', 'promo_code');

  -- Independent of the code, so it reveals nothing about any code.
  if v_paid_active then
    return jsonb_build_object('ok', false, 'code', 'PROMO_PAID_ACTIVE');
  end if;

  select * into v_promo from public.promo_codes where code = v_norm for update;
  v_found := found;

  if v_found and exists (select 1 from public.promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_ALREADY_REDEEMED');
  end if;

  v_end := case when v_found then v_today + v_promo.duration_days else null end;

  -- ONE generic verdict for: no such code, disabled, expired, exhausted, or a code that
  -- would not extend an admin/promo entitlement the user already holds longer.
  if not v_found
     or v_promo.status <> 'active'
     -- an address-bound code is usable only by the account whose keyed e-mail hash matches; any other
     -- account (or no hash at all) takes the SAME generic verdict as every other unusable code
     or (v_promo.bound_email_hash is not null and v_promo.bound_email_hash is distinct from p_email_hash)
     or (v_promo.expires_on is not null and v_promo.expires_on < v_today)
     or (v_promo.max_redemptions is not null and v_promo.redemption_count >= v_promo.max_redemptions)
     or (v_managed_active and v_row.effective_to >= v_end) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_CODE_UNUSABLE');
  end if;

  v_from := case when v_managed_active then coalesce(v_row.effective_from, v_today) else v_today end;

  update public.user_entitlements
     set plan_tier = 'premium', entitlement_source = 'promo_code',
         effective_from = v_from, effective_to = v_end,
         admin_grant_ends_on = v_end, reserve_source = 'promo_code',
         admin_grant_extension_count = 0, promo_code_id = v_promo.id,
         updated_at = now()
   where user_id = p_user_id;

  update public.promo_codes set redemption_count = redemption_count + 1 where id = v_promo.id;
  insert into public.promo_code_redemptions (promo_code_id, user_id, entitlement_ends_on) values (v_promo.id, p_user_id, v_end);
  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('redeem', p_user_id, v_promo.id, v_promo.code_hint,
          jsonb_build_object('ends_on', v_end, 'before_source', v_row.entitlement_source, 'before_plan_tier', v_row.plan_tier,
                             'extended_existing', v_managed_active));
  update public.promo_redemption_attempts set succeeded = true where id = v_attempt;

  return jsonb_build_object('ok', true, 'ends_on', v_end, 'started_on', v_from);
end;
$fn$;

revoke all on function public.redeem_promo_code_for_user(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_promo_code_for_user(uuid, text, text, text) to service_role;

-- 4. list (return type gains `bound`)
drop function if exists public.admin_list_promo_codes();
create or replace function public.admin_list_promo_codes()
returns table (
  id uuid, code text, code_hint text, duration_days int, max_redemptions int, redemption_count int,
  expires_on date, note text, status text, state text, created_at timestamptz, created_by_email text,
  bound boolean
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_today date := current_date;
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return query
    select p.id, p.code, p.code_hint, p.duration_days, p.max_redemptions, p.redemption_count, p.expires_on, p.note, p.status,
           case when p.status = 'disabled' then 'disabled'
                when p.expires_on is not null and p.expires_on < v_today then 'expired'
                when p.max_redemptions is not null and p.redemption_count >= p.max_redemptions then 'exhausted'
                else 'active' end,
           p.created_at, u.email::text, (p.bound_email_hash is not null)
      from public.promo_codes p left join auth.users u on u.id = p.created_by
     order by p.created_at desc limit 500;
end;
$fn$;

revoke all on function public.admin_list_promo_codes() from public, anon;
grant execute on function public.admin_list_promo_codes() to authenticated;

-- 5. Idempotency + send ledger (no address, no body, no code value)
create table if not exists public.promo_email_requests (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  request_key text not null check (char_length(request_key) between 8 and 100),
  recipient_count int not null check (recipient_count between 1 and 20),
  bound boolean not null default false,
  created_at timestamptz not null default now(),
  constraint uq_promo_email_request unique (admin_user_id, request_key)
);
create index if not exists idx_promo_email_requests_admin_time on public.promo_email_requests (admin_user_id, created_at desc);

create table if not exists public.promo_email_sends (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  request_key text not null,
  promo_code_id uuid not null references public.promo_codes(id),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('sent', 'failed', 'abandoned')),
  attempts int not null default 1 check (attempts between 1 and 10),
  last_error text check (last_error is null or char_length(last_error) <= 200),
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_promo_email_send unique (admin_user_id, request_key, promo_code_id, recipient_hash)
);
comment on table public.promo_email_sends is
  'Promo e-mail dispatch ledger: one row per (admin, request key, code, recipient KEYED hash). Holds no address, body or code value.';

alter table public.promo_email_requests enable row level security;
alter table public.promo_email_sends enable row level security;
drop policy if exists "promo admin reads email requests" on public.promo_email_requests;
create policy "promo admin reads email requests" on public.promo_email_requests for select using (public.is_promo_code_admin());
drop policy if exists "promo admin reads email sends" on public.promo_email_sends;
create policy "promo admin reads email sends" on public.promo_email_sends for select using (public.is_promo_code_admin());
revoke all on public.promo_email_requests, public.promo_email_sends from anon, authenticated;
grant select on public.promo_email_requests, public.promo_email_sends to authenticated;

-- Begin a dispatch request: capability-checked, per-admin rate-limited, idempotent per key.
-- Returns {"new": true} the first time a key is seen and {"new": false} for a duplicate (the caller must
-- then create nothing and send nothing).
create or replace function public.admin_promo_email_begin(p_request_key text, p_recipient_count int, p_bound boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_recent_requests int;
  v_recent_recipients int;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_request_key is null or char_length(p_request_key) < 8 or char_length(p_request_key) > 100 then
    raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023';
  end if;
  if p_recipient_count is null or p_recipient_count < 1 or p_recipient_count > 20 then
    raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023';
  end if;

  if exists (select 1 from public.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key) then
    return jsonb_build_object('new', false);
  end if;

  select count(*), coalesce(sum(recipient_count), 0) into v_recent_requests, v_recent_recipients
    from public.promo_email_requests
   where admin_user_id = v_actor and created_at > now() - interval '1 hour';
  if v_recent_requests >= 10 or v_recent_recipients + p_recipient_count > 100 then
    raise exception 'PROMO_EMAIL_RATE_LIMITED' using errcode = 'P0001';
  end if;

  insert into public.promo_email_requests (admin_user_id, request_key, recipient_count, bound)
  values (v_actor, p_request_key, p_recipient_count, coalesce(p_bound, false))
  on conflict on constraint uq_promo_email_request do nothing
  returning id into v_id;
  return jsonb_build_object('new', v_id is not null);
end;
$fn$;
revoke all on function public.admin_promo_email_begin(text, int, boolean) from public, anon;
grant execute on function public.admin_promo_email_begin(text, int, boolean) to authenticated;

-- Record a send outcome (upsert per recipient hash). Only the keyed hash is stored.
create or replace function public.admin_promo_email_record(
  p_request_key text, p_promo_code_id uuid, p_recipient_hash text, p_status text,
  p_attempts int, p_message_id text, p_error text
) returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_status not in ('sent', 'failed', 'abandoned') then raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023'; end if;
  if not exists (select 1 from public.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key) then
    return false;
  end if;
  insert into public.promo_email_sends (admin_user_id, request_key, promo_code_id, recipient_hash, status, attempts, last_error, provider_message_id)
  values (v_actor, p_request_key, p_promo_code_id, p_recipient_hash, p_status, least(greatest(coalesce(p_attempts, 1), 1), 10),
          left(p_error, 200), left(p_message_id, 200))
  on conflict on constraint uq_promo_email_send do update
    set status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error,
        provider_message_id = excluded.provider_message_id, updated_at = now()
    -- a settled 'sent' row is never downgraded
    where public.promo_email_sends.status <> 'sent';
  return true;
end;
$fn$;
revoke all on function public.admin_promo_email_record(text, uuid, text, text, int, text, text) from public, anon;
grant execute on function public.admin_promo_email_record(text, uuid, text, text, int, text, text) to authenticated;
