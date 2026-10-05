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
