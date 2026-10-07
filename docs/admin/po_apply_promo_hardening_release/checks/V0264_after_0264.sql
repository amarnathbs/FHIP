-- V0264 check after migration 0264 (read only, safe to run any number of times)
-- Paste the whole file in the SQL editor and press Run. You get one row per check.
-- The column ok must say true on every row. Dates are written day first.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'last day of a 30 day window that starts 28-02-2024' as check_name,
         to_char(public.access_end_date(date '2024-02-28', 30), 'DD-MM-YYYY') as actual, '28-03-2024' as expected
  union all select 2, 'length of that window in days', public.access_window_days(date '2024-02-28', date '2024-03-28')::text, '30'
  union all select 3, 'e-mail normalising trims and lower-cases', public.promo_normalise_email(E'  A@B.COM\n'), 'a@b.com'
  union all select 4, 'lifetime ceiling of admin grants and extensions per person', public.premium_grant_lifetime_ceiling()::text, '10'
  union all select 5, 'people who hold the override capability (nobody until you decide)', (select count(*) from public.admin_users where can_override_entitlement_limits)::text, '0'
  union all select 6, 'override capability check function exists', (to_regprocedure('public.is_entitlement_override_admin()') is not null)::text, 'true'
  union all select 7, 'monitoring table exists', (to_regclass('public.admin_monitoring_events') is not null)::text, 'true'
  union all select 8, 'override record table exists', (to_regclass('public.premium_entitlement_overrides') is not null)::text, 'true'
  union all select 9, 'lifetime counter column exists', (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_entitlements' and column_name = 'admin_lifetime_grant_units')::text, 'true'
  union all select 10, 'people whose counter is below their audited grants and extensions',
         (select count(*) from (select target_user_id, count(*) as c from public.admin_entitlement_events where action in ('grant', 'extend') group by target_user_id) a
            join public.user_entitlements e on e.user_id = a.target_user_id where e.admin_lifetime_grant_units < a.c)::text, '0'
  union all select 11, 'promo code protected columns added (digest, version, verified time, anonymised time)',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name in ('code_digest', 'code_digest_version', 'code_digest_verified_at', 'anonymised_at'))::text, '4'
  union all select 12, 'the plain code column accepts empty values now', (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'code'), 'YES'
  union all select 13, 'signed-in users can read the plain code column', has_column_privilege('authenticated', 'public.promo_codes', 'code', 'select')::text, 'false'
  union all select 14, 'signed-in users can read the digest column', has_column_privilege('authenticated', 'public.promo_codes', 'code_digest', 'select')::text, 'false'
  union all select 15, 'signed-in users can read the bound address hash column', has_column_privilege('authenticated', 'public.promo_codes', 'bound_email_hash', 'select')::text, 'false'
  union all select 16, 'signed-in users can still read the masked hint column', has_column_privilege('authenticated', 'public.promo_codes', 'code_hint', 'select')::text, 'true'
  union all select 17, 'one digest per code is enforced', (to_regclass('public.uq_promo_codes_digest') is not null)::text, 'true'
) c
order by n;
