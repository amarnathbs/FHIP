-- V_compare_with_backup compares the live table with the backup made by backfill/B1 (read only). Needs B1.
-- It proves the backfill changed only the rows it was meant to change, and no consumer counter.
-- Row 3 can be above zero on a busy production database if a customer paid, cancelled or redeemed a code after the backup was taken.
-- If it is not 0, run V_compare_list_changed_ids.sql: it lists only the user ids of those rows (no e-mail) so we can judge them.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'rows in the backup' as check_name, (select count(*) from private.bk_user_entitlements_before_staff_premium)::text as actual, null::text as expected
  union all select 2, 'accounts that were changed to Staff Premium since the backup',
         (select count(*) from public.user_entitlements e join private.bk_user_entitlements_before_staff_premium b on b.user_id = e.user_id
           where e.entitlement_source = 'staff_admin' and b.entitlement_source <> 'staff_admin')::text, null
  union all select 3, 'rows that are NOT staff rows and differ against the backup (expected 0 unless customers changed their plan since the backup)',
         (select count(*) from public.user_entitlements e join private.bk_user_entitlements_before_staff_premium b on b.user_id = e.user_id
           where e.entitlement_source <> 'staff_admin'
             and (e.plan_tier, e.entitlement_source, e.effective_from, e.effective_to, e.admin_grant_ends_on, e.reserve_source, e.promo_code_id, e.provider, e.subscription_status)
                 is distinct from (b.plan_tier, b.entitlement_source, b.effective_from, b.effective_to, b.admin_grant_ends_on, b.reserve_source, b.promo_code_id, b.provider, b.subscription_status))::text, '0'
  union all select 4, 'accounts whose lifetime grant counter differs against the backup (must be none: staff rows never touch the consumer limits)',
         (select count(*) from public.user_entitlements e join private.bk_user_entitlements_before_staff_premium b on b.user_id = e.user_id
           where e.admin_lifetime_grant_units is distinct from b.admin_lifetime_grant_units)::text, '0'
  union all select 5, 'accounts whose payment provider fields differ against the backup (must be none)',
         (select count(*) from public.user_entitlements e join private.bk_user_entitlements_before_staff_premium b on b.user_id = e.user_id
           where (e.provider, e.provider_customer_id, e.provider_subscription_id, e.price_id) is distinct from (b.provider, b.provider_customer_id, b.provider_subscription_id, b.price_id))::text, '0'
) c
order by n;

