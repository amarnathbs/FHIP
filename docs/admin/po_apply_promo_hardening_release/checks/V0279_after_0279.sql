-- V0279 check after migration 0279, the cleanup (read only, safe to repeat)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.
-- After it each function name below exists exactly once, and the old list function is gone.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'create functions' as check_name, (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_create_promo_code')::text as actual, '1' as expected
  union all select 2, 'redeem functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'redeem_promo_code_for_user')::text, '1'
  union all select 3, 'grant functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_manage_premium_entitlement')::text, '1'
  union all select 4, 'e-mail request start functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_promo_email_begin')::text, '1'
  union all select 5, 'the old list function (it returned the plain code) is gone', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_list_promo_codes')::text, '0'
  union all select 6, 'the new list function exists', (to_regprocedure('public.admin_list_promo_codes_v2()') is not null)::text, 'true'
  union all select 7, 'people whose lifetime counter differs against the audited grants and extensions',
         (select count(*) from (select target_user_id, count(*) as c from public.admin_entitlement_events where action in ('grant', 'extend') group by target_user_id) a
            join public.user_entitlements e on e.user_id = a.target_user_id where e.admin_lifetime_grant_units < a.c)::text, '0'
  union all select 8, 'codes that still hold their text', (select count(*) from public.promo_codes where code is not null)::text, '0'
  union all select 9, 'cleanup evidence rows', (select count(*) from public.admin_monitoring_events where event_type = 'promo_hardening_legacy_cleanup')::text, null
) c
order by n;
