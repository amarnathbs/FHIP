-- V0283 check after migration 0283 (read only, safe to run any number of times).
-- Paste the whole file in the SQL editor and press Run. You get one row per check. The column ok must say true on every row.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'the source rule now allows staff_admin' as check_name,
         (position('staff_admin' in pg_get_constraintdef(oid)) > 0)::text as actual, 'true' as expected
    from pg_constraint where conname = 'user_entitlements_entitlement_source_check' and conrelid = 'public.user_entitlements'::regclass
  union all select 2, 'the three earlier sources are still allowed',
         (select (position('payment' in d) > 0 and position('admin_grant' in d) > 0 and position('promo_code' in d) > 0)::text
            from (select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'user_entitlements_entitlement_source_check' and conrelid = 'public.user_entitlements'::regclass) x), 'true'
  union all select 3, 'the shape rules exist (earlier managed rule widened, new staff rule added)',
         (select count(*) from pg_constraint where conrelid = 'public.user_entitlements'::regclass and conname in ('user_entitlements_managed_source_shape_check', 'user_entitlements_staff_source_shape_check'))::text, '2'
  union all select 4, 'the audit table exists with row level security on',
         (select coalesce(relrowsecurity, false) from pg_class where oid = to_regclass('public.staff_premium_events'))::text, 'true'
  union all select 5, 'the audit table cannot be edited (update, delete and truncate guards)',
         (select count(*) from pg_trigger where tgrelid = to_regclass('public.staff_premium_events') and not tgisinternal and tgenabled = 'O')::text, '2'
  union all select 6, 'the three staff triggers exist and are enabled',
         (select count(*) from pg_trigger where tgname in ('trg_staff_premium_guard', 'trg_staff_premium_admin_users', 'trg_staff_premium_resource_roles') and not tgisinternal and tgenabled = 'O')::text, '3'
  union all select 7, 'the staff functions exist',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('is_staff_premium_account', 'staff_premium_guard', 'staff_premium_sync_user', 'staff_premium_reconcile',
                 'staff_premium_after_admin_users', 'staff_premium_after_resource_roles', 'admin_list_staff_premium', 'admin_staff_premium_history'))::text, '8'
  union all select 8, 'a signed-in website user cannot run the sync, the reconcile or the staff test',
         (has_function_privilege('authenticated', 'public.staff_premium_sync_user(uuid,text)', 'execute')
          or has_function_privilege('authenticated', 'public.staff_premium_reconcile(boolean)', 'execute')
          or has_function_privilege('authenticated', 'public.is_staff_premium_account(uuid)', 'execute'))::text, 'false'
  union all select 9, 'an anonymous visitor cannot run the two screen functions',
         (has_function_privilege('anon', 'public.admin_list_staff_premium()', 'execute') or has_function_privilege('anon', 'public.admin_staff_premium_history(uuid,int)', 'execute'))::text, 'false'
  union all select 10, 'signed-in users can read the audit table only through the capability rule (no write privilege)',
         (has_table_privilege('authenticated', 'public.staff_premium_events', 'insert') or has_table_privilege('authenticated', 'public.staff_premium_events', 'update') or has_table_privilege('authenticated', 'public.staff_premium_events', 'delete'))::text, 'false'
  union all select 11, 'consumer rule unchanged: lifetime ceiling of admin grants and extensions per person', public.premium_grant_lifetime_ceiling()::text, '10'
  union all select 12, 'consumer rule unchanged: extensions per grant', public.premium_grant_max_extensions()::text, '5'
  union all select 13, 'consumer rule unchanged: a grant may end at most 364 days after today (365 days counting today)', (public.access_end_date(current_date, 365) - current_date)::text, '364'
  union all select 14, 'the override capability is still held by nobody', (select count(*) from public.admin_users where can_override_entitlement_limits)::text, '0'
  union all select 15, 'no staff entitlement exists yet (expected before the backfill, run V_after_backfill afterwards)', (select count(*) from public.user_entitlements where entitlement_source = 'staff_admin')::text, null
) c
order by n;
