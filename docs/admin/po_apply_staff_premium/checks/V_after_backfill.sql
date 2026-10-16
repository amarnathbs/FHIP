-- V_after_backfill check after the backfill B3 (read only, safe to run any number of times).
-- Paste the whole file in the SQL editor and press Run. You get one row per check. The column ok must say true on every row.
-- Row 1 and row 2 are information (their ok is always true): they tell you how many accounts there are. Row 2 can be lower than row 1
-- by the number of staff accounts that hold a paid subscription (a paid plan wins).

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'staff accounts today (Super Admin rows plus active Resource Administrator and Editor roles)' as check_name,
         (select count(*) from auth.users u where public.is_staff_premium_account(u.id))::text as actual, null::text as expected
  union all select 2, 'of those: holding Staff Premium',
         (select count(*) from public.user_entitlements e where e.entitlement_source = 'staff_admin')::text, null
  union all select 3, 'staff accounts that have neither Staff Premium nor a paid Premium subscription today (must be none)',
         (select count(*) from auth.users u
            left join public.user_entitlements e on e.user_id = u.id
           where public.is_staff_premium_account(u.id)
             and not coalesce(e.entitlement_source = 'staff_admin' and e.plan_tier = 'premium', false)
             and not coalesce(e.entitlement_source = 'payment' and e.plan_tier = 'premium'
                      and (e.effective_from is null or e.effective_from <= current_date) and (e.effective_to is null or e.effective_to >= current_date), false))::text, '0'
  union all select 4, 'Staff Premium rows on an account that is NOT staff (must be none)',
         (select count(*) from public.user_entitlements e where e.entitlement_source = 'staff_admin' and not public.is_staff_premium_account(e.user_id))::text, '0'
  union all select 5, 'Staff Premium rows with an end date or a time limited reserve (must be none)',
         (select count(*) from public.user_entitlements e where e.entitlement_source = 'staff_admin'
            and (e.effective_to is not null or e.admin_grant_ends_on is not null or e.reserve_source is not null or e.plan_tier <> 'premium'))::text, '0'
  union all select 6, 'ordinary customers holding a staff row (must be none)',
         (select count(*) from public.user_entitlements e where e.entitlement_source = 'staff_admin'
            and not exists (select 1 from public.admin_users a where a.user_id = e.user_id)
            and not exists (select 1 from public.resource_user_roles r where r.user_id = e.user_id and r.is_active))::text, '0'
  union all select 7, 'the reconcile finds nothing left to do (a second run would change nothing)',
         (select count(*) from public.staff_premium_reconcile(true) where planned not in ('keep_staff', 'keep_paid'))::text, '0'
) c
order by n;
