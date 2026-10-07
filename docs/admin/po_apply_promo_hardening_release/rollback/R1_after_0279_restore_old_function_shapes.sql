-- R1 rollback of 0279, the legacy cleanup: put the OLD function shapes back
-- =============================================================================
-- Hand-run. The bodies below are the exact text of the migrations that created these functions (0231, 0237, 0242).
--
-- READ FIRST. 0279 only runs after the plain code values were blanked by the finalise step. This file puts the old
-- FUNCTIONS back, but the plain values are gone, so the OLD application release still cannot redeem an existing code.
-- If the old release must serve users again, restore the database using the backup taken before the finalise step instead.
-- Use this file when you only need the old function shapes to exist again (for example to re-run the cleanup later).
-- =============================================================================

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

create or replace function public.redeem_promo_code_for_user(p_user_id uuid, p_code text, p_ip_hash text, p_email_hash text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_norm text := public.promo_normalise_code(p_code);
  v_row record;
  v_promo record;
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

  insert into public.user_entitlements (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements where user_id = p_user_id for update;
  v_active_premium := v_row.plan_tier = 'premium'
    and (v_row.effective_from is null or v_row.effective_from <= v_today)
    and (v_row.effective_to is null or v_row.effective_to >= v_today);
  v_paid_active := v_active_premium and v_row.entitlement_source = 'payment';
  v_managed_active := v_active_premium and v_row.entitlement_source in ('admin_grant', 'promo_code');

  if v_paid_active then
    return jsonb_build_object('ok', false, 'code', 'PROMO_PAID_ACTIVE');
  end if;

  select * into v_promo from public.promo_codes where code = v_norm for update;
  v_found := found;

  if v_found and exists (select 1 from public.promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_ALREADY_REDEEMED');
  end if;

  v_end := case when v_found then v_today + v_promo.duration_days else null end;

  if not v_found
     or v_promo.status <> 'active'
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

create or replace function public.admin_manage_premium_entitlement(
  p_action text, p_target_user_id uuid, p_ends_on date, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor          uuid := auth.uid();
  v_today          date := current_date;
  v_max_days       constant int := 365;
  v_max_ext        int := public.premium_grant_max_extensions();
  v_reason         text := btrim(coalesce(p_reason, ''));
  v_row            record;
  v_after          record;
  v_window_current boolean;
  v_active_premium boolean;
  v_paid_active    boolean;
  v_managed_active boolean;
  v_managed_source boolean;
  v_event_id       uuid;
begin
  if v_actor is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;

  if p_action is null or p_action not in ('grant', 'extend', 'revoke') then raise exception 'ENTITLEMENT_ACTION_INVALID' using errcode = '22023'; end if;
  if p_target_user_id is null then raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) < 10 then raise exception 'ENTITLEMENT_REASON_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) > 1000 then raise exception 'ENTITLEMENT_REASON_TOO_LONG' using errcode = '22023'; end if;
  if p_action in ('grant', 'extend') then
    if p_ends_on is null then raise exception 'ENTITLEMENT_END_DATE_REQUIRED' using errcode = '22023'; end if;
    if p_ends_on < v_today then raise exception 'ENTITLEMENT_END_DATE_IN_PAST' using errcode = '22023'; end if;
    if p_ends_on > v_today + v_max_days then raise exception 'ENTITLEMENT_END_DATE_EXCEEDS_MAX' using errcode = '22023'; end if;
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
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = v_today, effective_to = p_ends_on,
           admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = 0, promo_code_id = null,
           updated_at = now()
     where user_id = p_target_user_id;

  elsif p_action = 'extend' then
    if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;
    if not v_managed_source then raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001'; end if;
    if v_row.admin_grant_extension_count >= v_max_ext then raise exception 'ENTITLEMENT_EXTENSION_LIMIT_REACHED' using errcode = 'P0001'; end if;
    if v_managed_active and p_ends_on <= v_row.effective_to then raise exception 'ENTITLEMENT_EXTENSION_NOT_LATER' using errcode = 'P0001'; end if;
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = case when v_managed_active then v_row.effective_from else v_today end,
           effective_to = p_ends_on, admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = v_row.admin_grant_extension_count + 1,
           updated_at = now()
     where user_id = p_target_user_id;

  else
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

  return jsonb_build_object(
    'audit_id', v_event_id, 'action', p_action, 'target_user_id', p_target_user_id, 'as_of', v_today,
    'plan_tier', v_after.plan_tier, 'entitlement_source', v_after.entitlement_source,
    'effective_from', v_after.effective_from, 'effective_to', v_after.effective_to,
    'admin_grant_ends_on', v_after.admin_grant_ends_on,
    'extension_count', v_after.admin_grant_extension_count,
    'extensions_remaining', greatest(v_max_ext - v_after.admin_grant_extension_count, 0)
  );
end;
$fn$;
comment on function public.admin_manage_premium_entitlement(text, uuid, date, text) is
  'Admin Premium grant (0231): the only write path for admin grant/extend/revoke. Capability-checked on auth.uid(), 365-day cap, mandatory reason, refuses to touch a paid/non-admin Premium, audit row written atomically.';
revoke all on function public.admin_manage_premium_entitlement(text, uuid, date, text) from public, anon;
grant execute on function public.admin_manage_premium_entitlement(text, uuid, date, text) to authenticated;

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
