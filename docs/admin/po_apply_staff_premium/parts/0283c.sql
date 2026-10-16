-- ---------------------------------------------------------------------------
-- PART C starts here: two read functions for the Admin Premium Access screen
-- ---------------------------------------------------------------------------
-- Capability: can_manage_premium_entitlements (the existing, separately named capability), checked inside each function on
-- auth.uid(). No new capability is created and nobody is granted anything by this migration. Both are read only.
-- Returned: the e-mail address the Premium Access screen already shows to this capability, the staff role names, and the entitlement
-- state. No financial data of any kind.

create or replace function public.admin_list_staff_premium()
returns table (
  user_id uuid,
  email text,
  roles text,
  plan_tier text,
  entitlement_source text,
  effective_from date,
  entitlement_active boolean,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           nullif(concat_ws(', ',
             case when exists (select 1 from public.admin_users a where a.user_id = u.id) then 'Super Admin' end,
             (select string_agg(r.role, ', ' order by r.role) from public.resource_user_roles r where r.user_id = u.id and r.is_active)
           ), ''),
           coalesce(e.plan_tier, 'free'),
           coalesce(e.entitlement_source, 'payment'),
           e.effective_from,
           coalesce(e.plan_tier = 'premium'
                    and (e.effective_from is null or e.effective_from <= v_today)
                    and (e.effective_to is null or e.effective_to >= v_today), false),
           case
             when not public.is_staff_premium_account(u.id) then 'stray_staff_row'
             when e.entitlement_source = 'staff_admin' and e.plan_tier = 'premium' then 'staff_premium'
             when e.plan_tier = 'premium' and e.entitlement_source = 'payment'
                  and (e.effective_from is null or e.effective_from <= v_today)
                  and (e.effective_to is null or e.effective_to >= v_today) then 'paid_subscription'
             else 'not_applied' end
      from auth.users u
      left join public.user_entitlements e on e.user_id = u.id
     where public.is_staff_premium_account(u.id) or e.entitlement_source = 'staff_admin'
     order by u.email
     limit 500;
end;
$fn$;
comment on function public.admin_list_staff_premium() is
  'Staff admin Premium (0283): staff accounts and their entitlement state for the Premium Access screen. state is staff_premium, paid_subscription (a paid plan wins), not_applied (the backfill has not run for this account) or stray_staff_row (a staff row on an account that is no longer staff). Capability can_manage_premium_entitlements, checked on auth.uid().';
revoke all on function public.admin_list_staff_premium() from public, anon;
grant execute on function public.admin_list_staff_premium() to authenticated;

create or replace function public.admin_staff_premium_history(p_target_user_id uuid, p_limit int default 50)
returns table (
  id uuid,
  created_at timestamptz,
  action text,
  origin text,
  replaced_source text,
  before_plan_tier text,
  before_entitlement_source text,
  after_plan_tier text,
  after_entitlement_source text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_target_user_id is null then
    raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023';
  end if;

  return query
    select ev.id, ev.created_at, ev.action, ev.origin, ev.replaced_source,
           ev.before_plan_tier, ev.before_entitlement_source, ev.after_plan_tier, ev.after_entitlement_source
      from public.staff_premium_events ev
     where ev.target_user_id = p_target_user_id
     order by ev.created_at desc, ev.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$fn$;
comment on function public.admin_staff_premium_history(uuid, int) is
  'Staff admin Premium (0283): the start, end and paid_over events of one account, newest first. Capability can_manage_premium_entitlements, checked on auth.uid().';
revoke all on function public.admin_staff_premium_history(uuid, int) from public, anon;
grant execute on function public.admin_staff_premium_history(uuid, int) to authenticated;
