-- R2 remove everything migration 0283 created and put the two constraints back as they were (0237). Run R1 first.
-- It refuses while any staff row exists. The audit table staff_premium_events is dropped with it, so copy its rows out first if you want them.
-- The B1 backup table is NOT dropped here. Drop it yourself when you no longer need it (drop table private.bk_user_entitlements_before_staff_premium).

do $fn$
begin
  if exists (select 1 from public.user_entitlements where entitlement_source = 'staff_admin') then
    raise exception 'STAFF_PREMIUM_UNDO_BLOCKED: staff rows still exist, run R1 first' using errcode = 'P0001';
  end if;
end
$fn$;

drop trigger if exists trg_staff_premium_guard on public.user_entitlements;
drop trigger if exists trg_staff_premium_admin_users on public.admin_users;
drop trigger if exists trg_staff_premium_resource_roles on public.resource_user_roles;

drop function if exists public.admin_staff_premium_history(uuid, int);
drop function if exists public.admin_list_staff_premium();
drop function if exists public.staff_premium_reconcile(boolean);
drop function if exists public.staff_premium_after_resource_roles();
drop function if exists public.staff_premium_after_admin_users();
drop function if exists public.staff_premium_sync_user(uuid, text);
drop function if exists public.staff_premium_guard();
drop function if exists public.is_staff_premium_account(uuid);

drop table if exists public.staff_premium_events;
drop function if exists public.staff_premium_events_immutable();

alter table public.user_entitlements drop constraint if exists user_entitlements_staff_source_shape_check;

alter table public.user_entitlements drop constraint if exists user_entitlements_entitlement_source_check;
alter table public.user_entitlements
  add constraint user_entitlements_entitlement_source_check
  check (entitlement_source in ('payment', 'admin_grant', 'promo_code'));

alter table public.user_entitlements drop constraint if exists user_entitlements_managed_source_shape_check;
alter table public.user_entitlements
  add constraint user_entitlements_managed_source_shape_check
  check (entitlement_source = 'payment' or (plan_tier = 'premium' and admin_grant_ends_on is not null));

comment on column public.user_entitlements.entitlement_source is
  'Admin Premium grant (0231): what currently confers this row tier. payment = Stripe or Razorpay (or a manually set row that pre-dates 0231). admin_grant = allocated by an FHIP admin. promo_code = a redeemed promo code (0237). Only meaningful when plan_tier is premium.';

select (to_regprocedure('public.is_staff_premium_account(uuid)') is null) and (to_regclass('public.staff_premium_events') is null) as ok;
