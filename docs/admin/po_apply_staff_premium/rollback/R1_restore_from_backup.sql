-- R1 undo the DATA of the backfill. Needs the backup made by backfill/B1.
-- It switches the three triggers off first (otherwise they would put Staff Premium straight back), then:
--   1. every staff row goes back to exactly the values it had in the backup (a replaced admin grant or promo returns as it was),
--   2. a staff row that is not in the backup (an account made staff after B1) goes back to Free.
-- Rows that are not staff rows are never touched. The triggers stay OFF. To switch the feature back on run
-- R3_switch_triggers_on.sql. To remove the feature completely run R2_undo_0283.sql next.

alter table public.user_entitlements disable trigger trg_staff_premium_guard;
alter table public.admin_users disable trigger trg_staff_premium_admin_users;
alter table public.resource_user_roles disable trigger trg_staff_premium_resource_roles;

update public.user_entitlements e
   set plan_tier = b.plan_tier, entitlement_source = b.entitlement_source, effective_from = b.effective_from,
       effective_to = b.effective_to, admin_grant_ends_on = b.admin_grant_ends_on, reserve_source = b.reserve_source,
       admin_grant_extension_count = b.admin_grant_extension_count, promo_code_id = b.promo_code_id, updated_at = now()
  from private.bk_user_entitlements_before_staff_premium b
 where e.user_id = b.user_id and e.entitlement_source = 'staff_admin' and b.entitlement_source <> 'staff_admin';

update public.user_entitlements e
   set plan_tier = 'free', entitlement_source = 'payment', effective_to = null, admin_grant_ends_on = null,
       reserve_source = null, promo_code_id = null, admin_grant_extension_count = 0, updated_at = now()
 where e.entitlement_source = 'staff_admin';

select count(*) as staff_rows_left, count(*) = 0 as ok from public.user_entitlements where entitlement_source = 'staff_admin';
