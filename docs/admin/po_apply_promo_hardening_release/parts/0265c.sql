-- ---------------------------------------------------------------------------
-- PART C starts here: redeem by digest, verified address hash, shared window definition
-- ---------------------------------------------------------------------------
-- p_digests: the digests of the entered code under the current key version and, during a rotation window,
-- the previous one (at most 3 values). p_legacy_code: the normalised entered code, used ONLY to find a
-- legacy row that has no digest yet (before the backfill). p_email_hash: the keyed hash of the session
-- user address, supplied by the application only when that address is verified. Never a browser value.

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
