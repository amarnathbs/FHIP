-- 0265 promo and premium hardening, functions (part A of F)
-- =============================================================================
-- NEW migration on top of 0264 (apply 0264 first). The applied migrations 0231, 0237, 0238 and 0242 are
-- NOT edited. Functions they created are dropped and recreated here with the SAME owner (the migration
-- role), the SAME security mode (security definer), the SAME search_path (empty) and the SAME grants
-- (authenticated for the admin functions, service_role only for the redeem function).
--
-- WHAT THIS MIGRATION CHANGES
--   A  admin_create_promo_code: takes a keyed digest and a masked hint computed by the application. The
--      plain code is never seen by the database and never stored. Returns the id and the settings only.
--   B  admin_list_promo_codes: no code column any more.
--   C  redeem_promo_code_for_user: looks the code up by digest (current and previous key version), takes
--      the verified address hash, and ends a window of D days on the day redeemed plus D minus 1.
--   D  the digest backfill and finalise functions (service role only).
--   E  admin_manage_premium_entitlement: shared window definition, lifetime ceiling, override path.
--   F  premium_reminder_claim: window length measured by the shared definition.
--
-- OLD SIGNATURES ARE DROPPED. The application in this release calls only the new ones. Apply 0264 and
-- 0265 BEFORE deploying the application (the old application would find its create and redeem calls
-- gone and would show the explicit unavailable message until the new release is live).
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to F in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0265: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

-- Named constant: how long the redemption attempt ledger is kept (the redeem function prunes with it).
create or replace function public.promo_attempts_retention_days()
returns int
language sql
immutable
set search_path = ''
as $fn$ select 30; $fn$;
comment on function public.promo_attempts_retention_days() is
  'Hardening 0265 item 7: days a redemption attempt row is kept. Used by redeem_promo_code_for_user and seeded as the retention policy value for promo_redemption_attempts.';
revoke all on function public.promo_attempts_retention_days() from public, anon;
grant execute on function public.promo_attempts_retention_days() to authenticated, service_role;

drop function if exists public.admin_create_promo_code(text, int, int, boolean, date, boolean, text, text, int);

create or replace function public.admin_create_promo_code(
  p_code_digest text, p_code_hint text, p_digest_version int,
  p_duration_days int, p_max_redemptions int, p_unlimited boolean,
  p_expires_on date, p_no_expiry boolean, p_note text,
  p_bound_email_hash text default null, p_recipient_count int default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_today date := current_date;
  v_duration int := coalesce(p_duration_days, 30);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;

  -- The application computes the digest and the hint. Their shape is checked here, the value is not knowable here.
  if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  if p_digest_version is null or p_digest_version < 1 then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  if p_code_hint is null or p_code_hint !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}[*]{2,20}[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}$' then
    raise exception 'PROMO_CODE_INVALID' using errcode = '22023';
  end if;

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
  if p_bound_email_hash is not null then
    if p_bound_email_hash !~ '^[0-9a-f]{64}$' then raise exception 'PROMO_BINDING_INVALID' using errcode = '22023'; end if;
    if coalesce(p_unlimited, false) or p_max_redemptions is distinct from 1 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_recipient_count, 0) < 0 or coalesce(p_recipient_count, 0) > 20 then raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023'; end if;

  begin
    insert into public.promo_codes (code, code_digest, code_digest_version, code_digest_verified_at, code_hint, duration_days,
                                    max_redemptions, expires_on, note, created_by, bound_email_hash)
    values (null, p_code_digest, p_digest_version, now(), p_code_hint, v_duration,
            case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
            case when coalesce(p_no_expiry, false) then null else p_expires_on end, v_note, v_actor, p_bound_email_hash)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001';
  end;

  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('create', v_actor, v_id, p_code_hint, jsonb_build_object(
    'duration_days', v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'unlimited', coalesce(p_unlimited, false),
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end,
    'no_expiry', coalesce(p_no_expiry, false),
    'has_note', v_note is not null,
    'recipient_count', coalesce(p_recipient_count, 0),
    'bound', p_bound_email_hash is not null,
    'digest_version', p_digest_version));

  return jsonb_build_object('id', v_id, 'code_hint', p_code_hint, 'duration_days', v_duration,
    'bound', p_bound_email_hash is not null,
    'ends_if_redeemed_today', public.access_end_date(v_today, v_duration),
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end);
end;
$fn$;

revoke all on function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) from public, anon;
grant execute on function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) to authenticated;
-- ---------------------------------------------------------------------------
-- PART B starts here: the list no longer returns any code value
-- ---------------------------------------------------------------------------

drop function if exists public.admin_list_promo_codes();

create or replace function public.admin_list_promo_codes()
returns table (
  id uuid, code_hint text, duration_days int, max_redemptions int, redemption_count int,
  expires_on date, note text, status text, state text, created_at timestamptz, created_by_email text,
  bound boolean, ends_if_redeemed_today date, plain_stored boolean
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_today date := current_date;
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return query
    select p.id, p.code_hint, p.duration_days, p.max_redemptions, p.redemption_count, p.expires_on, p.note, p.status,
           case when p.status = 'disabled' then 'disabled'
                when p.expires_on is not null and p.expires_on < v_today then 'expired'
                when p.max_redemptions is not null and p.redemption_count >= p.max_redemptions then 'exhausted'
                else 'active' end,
           p.created_at, u.email::text, (p.bound_email_hash is not null),
           public.access_end_date(v_today, p.duration_days), (p.code is not null)
      from public.promo_codes p left join auth.users u on u.id = p.created_by
     order by p.created_at desc limit 500;
end;
$fn$;

revoke all on function public.admin_list_promo_codes() from public, anon;
grant execute on function public.admin_list_promo_codes() to authenticated;
-- ---------------------------------------------------------------------------
-- PART C starts here: redeem by digest, verified address hash, shared window definition
-- ---------------------------------------------------------------------------
-- p_digests: the digests of the entered code under the current key version and, during a rotation window,
-- the previous one (at most 3 values). p_legacy_code: the normalised entered code, used ONLY to find a
-- legacy row that has no digest yet (before the backfill). p_email_hash: the keyed hash of the session
-- user address, supplied by the application only when that address is verified. Never a browser value.

drop function if exists public.redeem_promo_code_for_user(uuid, text, text, text);

create or replace function public.redeem_promo_code_for_user(
  p_user_id uuid, p_digests text[], p_ip_hash text, p_email_hash text default null, p_legacy_code text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_norm text := public.promo_normalise_code(p_legacy_code);
  v_row record;
  v_promo record;
  v_found boolean := false;
  v_attempt uuid;
  v_user_attempts int;
  v_ip_attempts int;
  v_active_premium boolean;
  v_paid_active boolean;
  v_managed_active boolean;
  v_verified boolean;
  v_end date;
  v_from date;
begin
  select * into v_promo from public.promo_codes where false;
  if p_user_id is null then raise exception 'PROMO_USER_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'PROMO_USER_NOT_FOUND' using errcode = 'P0002'; end if;

  delete from public.promo_redemption_attempts
   where attempted_at < now() - make_interval(days => public.promo_attempts_retention_days());

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

  -- Lock order: the user entitlement row first, then the promo row.
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

  if p_digests is not null and cardinality(p_digests) between 1 and 3 then
    select * into v_promo from public.promo_codes where code_digest = any (p_digests) for update;
    v_found := found;
  end if;
  if not v_found and v_norm <> '' then
    select * into v_promo from public.promo_codes where code_digest is null and code = v_norm for update;
    v_found := found;
  end if;

  if v_found and exists (select 1 from public.promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_ALREADY_REDEEMED');
  end if;

  v_end := case when v_found then public.access_end_date(v_today, v_promo.duration_days) else null end;
  select (u.email_confirmed_at is not null) into v_verified from auth.users u where u.id = p_user_id;

  -- ONE generic verdict for: no such code, disabled, expired, exhausted, a bound code redeemed by any other
  -- account (or by an account whose address is not verified), or a code that would not extend an admin or
  -- promo entitlement the user already holds.
  if not v_found
     or v_promo.status <> 'active'
     or (v_promo.bound_email_hash is not null
         and (p_email_hash is null or coalesce(v_verified, false) = false or v_promo.bound_email_hash is distinct from p_email_hash))
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

revoke all on function public.redeem_promo_code_for_user(uuid, text[], text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_promo_code_for_user(uuid, text[], text, text, text) to service_role;
-- ---------------------------------------------------------------------------
-- PART D starts here: digest backfill and finalise (service role only)
-- ---------------------------------------------------------------------------
-- Run order for existing plain codes (the runbook has the full procedure):
--   1. scripts/promo_code_digest_backfill.mjs (dry run, then real) reads the pending rows, computes each
--      digest with the application secret, stores it, then asks the database to verify the copy.
--   2. promo_codes_finalise_hash_only(true) reports the counts. Only when every plain row is verified does
--      promo_codes_finalise_hash_only(false) blank the plain values. It is all or nothing.
-- A point in time backup before the real finalise is the reversal plan: after the blanking the plain
-- values exist nowhere, by design, and the digests keep every existing code working.

create or replace function public.promo_codes_digest_pending(p_limit int default 200)
returns table (id uuid, code text, code_digest text, code_digest_version int)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.code, p.code_digest, p.code_digest_version
    from public.promo_codes p
   where p.code is not null and p.code_digest_verified_at is null
   order by p.created_at, p.id
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$fn$;
revoke all on function public.promo_codes_digest_pending(int) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_pending(int) to service_role;

create or replace function public.promo_codes_digest_apply(p_id uuid, p_digest text, p_version int)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_version is null or p_version < 1 then
    raise exception 'PROMO_DIGEST_INVALID' using errcode = '22023';
  end if;
  update public.promo_codes
     set code_digest = p_digest, code_digest_version = p_version, code_digest_verified_at = null
   where id = p_id and code is not null and code_digest_verified_at is null;
  return found;
end;
$fn$;
revoke all on function public.promo_codes_digest_apply(uuid, text, int) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_apply(uuid, text, int) to service_role;

-- The caller recomputes the digest of the plain value it just read and passes it. The row is marked verified
-- only when the stored digest equals that recomputed value.
create or replace function public.promo_codes_digest_mark_verified(p_id uuid, p_recomputed_digest text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.promo_codes
     set code_digest_verified_at = now()
   where id = p_id and code is not null and code_digest is not null and code_digest = p_recomputed_digest;
  return found;
end;
$fn$;
revoke all on function public.promo_codes_digest_mark_verified(uuid, text) from public, anon, authenticated;
grant execute on function public.promo_codes_digest_mark_verified(uuid, text) to service_role;

create or replace function public.promo_codes_finalise_hash_only(p_dry_run boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_plain int;
  v_unverified int;
  v_total int;
  v_blanked int := 0;
begin
  select count(*) into v_total from public.promo_codes;
  select count(*) into v_plain from public.promo_codes where code is not null;
  select count(*) into v_unverified from public.promo_codes where code is not null and code_digest_verified_at is null;
  if coalesce(p_dry_run, true) then
    return jsonb_build_object('dry_run', true, 'rows_total', v_total, 'rows_with_plain_value', v_plain, 'rows_unverified', v_unverified);
  end if;
  if v_unverified > 0 then
    raise exception 'PROMO_FINALISE_BLOCKED' using errcode = 'P0001', detail = 'rows with a plain value and no verified digest: ' || v_unverified::text;
  end if;
  update public.promo_codes set code = null where code is not null and code_digest_verified_at is not null;
  get diagnostics v_blanked = row_count;
  insert into public.admin_monitoring_events (event_type, severity, details)
  values ('promo_codes_hash_only_finalised', 'info', jsonb_build_object('rows_blanked', v_blanked, 'rows_total', v_total));
  return jsonb_build_object('dry_run', false, 'rows_total', v_total, 'rows_blanked', v_blanked, 'rows_unverified', 0);
end;
$fn$;
revoke all on function public.promo_codes_finalise_hash_only(boolean) from public, anon, authenticated;
grant execute on function public.promo_codes_finalise_hash_only(boolean) to service_role;
-- ---------------------------------------------------------------------------
-- PART E starts here: grant, extend and revoke with the shared window, the lifetime ceiling and the override
-- ---------------------------------------------------------------------------
-- Changes against 0237 (same name, one new trailing parameter, so the old four argument form is dropped):
--   * the latest end date is the shared definition: access_end_date(today, 365), so a 365 day grant ends on
--     today plus 364 and never more than 365 calendar days are given at once.
--   * every successful grant and extend adds one to the user lifetime counter, a revoke never lowers it.
--   * a grant or extend past the per grant cap or the lifetime ceiling is refused, unless the caller passes
--     the override flag, holds the separate override capability, gives a reason of 20 or more characters and
--     a limit really was reached. An override leaves an append-only row and a high severity alert event.
-- New error codes: ENTITLEMENT_LIFETIME_LIMIT_REACHED, ENTITLEMENT_OVERRIDE_NOT_ALLOWED,
-- ENTITLEMENT_OVERRIDE_REASON_REQUIRED, ENTITLEMENT_OVERRIDE_NOT_NEEDED.

drop function if exists public.admin_manage_premium_entitlement(text, uuid, date, text);

create or replace function public.admin_manage_premium_entitlement(
  p_action text, p_target_user_id uuid, p_ends_on date, p_reason text, p_override boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor          uuid := auth.uid();
  v_today          date := current_date;
  v_max_days       constant int := 365;
  v_max_end        date := public.access_end_date(current_date, 365);
  v_max_ext        int := public.premium_grant_max_extensions();
  v_ceiling        int := public.premium_grant_lifetime_ceiling();
  v_override       boolean := coalesce(p_override, false);
  v_reason         text := btrim(coalesce(p_reason, ''));
  v_row            record;
  v_after          record;
  v_window_current boolean;
  v_active_premium boolean;
  v_paid_active    boolean;
  v_managed_active boolean;
  v_managed_source boolean;
  v_cap_hit        boolean := false;
  v_life_hit       boolean := false;
  v_limit_hit      text;
  v_event_id       uuid;
begin
  if v_actor is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;

  if p_action is null or p_action not in ('grant', 'extend', 'revoke') then raise exception 'ENTITLEMENT_ACTION_INVALID' using errcode = '22023'; end if;
  if p_target_user_id is null then raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) < 10 then raise exception 'ENTITLEMENT_REASON_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) > 1000 then raise exception 'ENTITLEMENT_REASON_TOO_LONG' using errcode = '22023'; end if;
  if v_override then
    if p_action = 'revoke' then raise exception 'ENTITLEMENT_ACTION_INVALID' using errcode = '22023'; end if;
    if not public.is_entitlement_override_admin() then raise exception 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED' using errcode = '42501'; end if;
    if char_length(v_reason) < 20 then raise exception 'ENTITLEMENT_OVERRIDE_REASON_REQUIRED' using errcode = '22023'; end if;
  end if;
  if p_action in ('grant', 'extend') then
    if p_ends_on is null then raise exception 'ENTITLEMENT_END_DATE_REQUIRED' using errcode = '22023'; end if;
    if p_ends_on < v_today then raise exception 'ENTITLEMENT_END_DATE_IN_PAST' using errcode = '22023'; end if;
    if p_ends_on > v_max_end then raise exception 'ENTITLEMENT_END_DATE_EXCEEDS_MAX' using errcode = '22023'; end if;
  end if;
  if p_target_user_id = v_actor then raise exception 'ENTITLEMENT_SELF_TARGET' using errcode = 'P0001'; end if;

  if not exists (select 1 from auth.users where id = p_target_user_id) then raise exception 'ENTITLEMENT_USER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.user_entitlements (user_id) values (p_target_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements where user_id = p_target_user_id for update;

  v_window_current := (v_row.effective_from is null or v_row.effective_from <= v_today)
                  and (v_row.effective_to   is null or v_row.effective_to   >= v_today);
  v_active_premium := v_row.plan_tier = 'premium' and v_window_current;
  v_managed_source := v_row.entitlement_source in ('admin_grant', 'promo_code');
  v_paid_active    := v_active_premium and not v_managed_source;
  v_managed_active := v_active_premium and v_managed_source;

  if p_action = 'grant' then
    if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;
    if v_managed_active then raise exception 'ENTITLEMENT_GRANT_ALREADY_ACTIVE' using errcode = 'P0001'; end if;
    v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;
  elsif p_action = 'extend' then
    if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;
    if not v_managed_source then raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001'; end if;
    v_cap_hit := v_row.admin_grant_extension_count >= v_max_ext;
    v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;
  end if;

  if p_action in ('grant', 'extend') then
    if v_cap_hit or v_life_hit then
      if not v_override then
        -- THE LIFETIME CEILING counts across revoke and re-grant, so it is reported first.
        if v_life_hit then raise exception 'ENTITLEMENT_LIFETIME_LIMIT_REACHED' using errcode = 'P0001'; end if;
        raise exception 'ENTITLEMENT_EXTENSION_LIMIT_REACHED' using errcode = 'P0001';
      end if;
      v_limit_hit := case when v_cap_hit and v_life_hit then 'both' when v_life_hit then 'lifetime_ceiling' else 'extension_cap' end;
    elsif v_override then
      raise exception 'ENTITLEMENT_OVERRIDE_NOT_NEEDED' using errcode = 'P0001';
    end if;
  end if;

  if p_action = 'grant' then
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = v_today, effective_to = p_ends_on,
           admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = 0, promo_code_id = null,
           admin_lifetime_grant_units = v_row.admin_lifetime_grant_units + 1,
           updated_at = now()
     where user_id = p_target_user_id;

  elsif p_action = 'extend' then
    if v_managed_active and p_ends_on <= v_row.effective_to then raise exception 'ENTITLEMENT_EXTENSION_NOT_LATER' using errcode = 'P0001'; end if;
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = case when v_managed_active then v_row.effective_from else v_today end,
           effective_to = p_ends_on, admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = v_row.admin_grant_extension_count + 1,
           admin_lifetime_grant_units = v_row.admin_lifetime_grant_units + 1,
           updated_at = now()
     where user_id = p_target_user_id;

  else -- revoke: the lifetime counter is deliberately NOT touched
    if v_managed_source then
      update public.user_entitlements
         set plan_tier = 'free', entitlement_source = 'payment', effective_to = null,
             admin_grant_ends_on = null, reserve_source = null,
             admin_grant_extension_count = 0, promo_code_id = null,
             updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active and v_row.admin_grant_ends_on is not null and v_row.admin_grant_ends_on >= v_today then
      update public.user_entitlements
         set admin_grant_ends_on = null, reserve_source = null, admin_grant_extension_count = 0,
             promo_code_id = null, updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001';
    else raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001';
    end if;
  end if;

  select * into v_after from public.user_entitlements where user_id = p_target_user_id;

  insert into public.admin_entitlement_events (
    action, actor_user_id, target_user_id, reason, requested_ends_on,
    before_plan_tier, before_entitlement_source, before_effective_from, before_effective_to, before_admin_grant_ends_on,
    after_plan_tier, after_entitlement_source, after_effective_from, after_effective_to, after_admin_grant_ends_on,
    extension_count_after
  ) values (
    p_action, v_actor, p_target_user_id, v_reason, case when p_action = 'revoke' then null else p_ends_on end,
    v_row.plan_tier, v_row.entitlement_source, v_row.effective_from, v_row.effective_to, v_row.admin_grant_ends_on,
    v_after.plan_tier, v_after.entitlement_source, v_after.effective_from, v_after.effective_to, v_after.admin_grant_ends_on,
    v_after.admin_grant_extension_count
  ) returning id into v_event_id;

  if v_override then
    insert into public.premium_entitlement_overrides (
      actor_user_id, target_user_id, action, limit_hit, reason, units_before, units_after, extension_count_before, requested_ends_on
    ) values (
      v_actor, p_target_user_id, p_action, v_limit_hit, v_reason, v_row.admin_lifetime_grant_units,
      v_after.admin_lifetime_grant_units, v_row.admin_grant_extension_count, p_ends_on
    );
    insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details)
    values ('premium_limit_override', 'high', v_actor, jsonb_build_object(
      'target_user_id', p_target_user_id, 'action', p_action, 'limit_hit', v_limit_hit,
      'units_after', v_after.admin_lifetime_grant_units, 'audit_id', v_event_id));
  end if;

  return jsonb_build_object(
    'audit_id', v_event_id, 'action', p_action, 'target_user_id', p_target_user_id, 'as_of', v_today,
    'plan_tier', v_after.plan_tier, 'entitlement_source', v_after.entitlement_source,
    'effective_from', v_after.effective_from, 'effective_to', v_after.effective_to,
    'admin_grant_ends_on', v_after.admin_grant_ends_on,
    'extension_count', v_after.admin_grant_extension_count,
    'extensions_remaining', greatest(v_max_ext - v_after.admin_grant_extension_count, 0),
    'lifetime_units', v_after.admin_lifetime_grant_units,
    'lifetime_remaining', greatest(v_ceiling - v_after.admin_lifetime_grant_units, 0),
    'override', v_override
  );
end;
$fn$;

revoke all on function public.admin_manage_premium_entitlement(text, uuid, date, text, boolean) from public, anon;
grant execute on function public.admin_manage_premium_entitlement(text, uuid, date, text, boolean) to authenticated;
comment on function public.admin_manage_premium_entitlement(text, uuid, date, text, boolean) is
  'Admin Premium grant (0231, hardened by 0265): the only write path for admin grant, extend and revoke. Capability checked on auth.uid(), 365 day inclusive cap, mandatory reason, a lifetime ceiling per user with a separately gated override, refuses to touch a paid or non-admin Premium, audit row written atomically.';
-- ---------------------------------------------------------------------------
-- PART F starts here: reminder claim measures a window with the shared definition
-- ---------------------------------------------------------------------------
-- Same function, same signature, same grants as 0238. Two changes:
--   1. a threshold of t days applies to a window that is LONGER than t days, and the length is
--      access_window_days (both ends inclusive), so a 30 day promo is a 30 day window and is not told it has
--      30 days left on the day it starts.
--   2. a LESS urgent threshold is never claimed once a MORE urgent one exists for the same window. This is what
--      makes the optional seven day reminder safe: after a seven day e-mail, turning that switch back off can
--      never produce a late thirty day e-mail about the same expiry.

create or replace function public.premium_reminder_claim(
  p_today date,
  p_thresholds int[],
  p_batch int default 50,
  p_max_attempts int default 3,
  p_retry_after_minutes int default 60,
  p_only_user uuid default null          -- targeted and test runs only, the cron route never passes it
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
  -- already-sent windows never consume the batch, ON CONFLICT is the race-safe backstop.
  with due as (
    select e.user_id, e.entitlement_source, e.effective_to as ends_on,
           (select min(x) from unnest(p_thresholds) x
             where (e.effective_to - p_today) <= x and public.access_window_days(coalesce(e.effective_from, p_today), e.effective_to) > x) as threshold
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
       -- A LESS urgent threshold is never claimed once a MORE urgent one exists for the same window (so a seven day
       -- reminder that was sent can never be followed by a late thirty day one when the switch is turned back off).
       and not exists (select 1 from public.premium_expiry_email_ledger y
                        where y.user_id = d.user_id and y.entitlement_source = d.entitlement_source
                          and y.ends_on = d.ends_on and y.threshold_days < d.threshold and y.status <> 'void')
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
