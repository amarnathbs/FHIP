-- V0265 check after migration 0265 (read only, safe to run any number of times)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.
-- Rows 1 to 7 prove the migration ADDED the new functions BESIDE the old ones (nothing was removed).

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'create functions (the old one plus the new one)' as check_name, (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_create_promo_code')::text as actual, '2' as expected
  union all select 2, 'redeem functions (the old one plus the new one)', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'redeem_promo_code_for_user')::text, '2'
  union all select 3, 'grant functions (the old one plus the new one)', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_manage_premium_entitlement')::text, '2'
  union all select 4, 'the old list function still exists', (to_regprocedure('public.admin_list_promo_codes()') is not null)::text, 'true'
  union all select 5, 'the new list function exists', (to_regprocedure('public.admin_list_promo_codes_v2()') is not null)::text, 'true'
  union all select 6, 'reminder claim function exists exactly once', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'premium_reminder_claim')::text, '1'
  union all select 7, 'the new grant function has no default value on its override flag', (select pronargdefaults from pg_proc where oid = to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text,boolean)'))::text, '0'
  union all select 8, 'signed-in users can run the new redeem function', has_function_privilege('authenticated', 'public.redeem_promo_code_for_user(uuid,text[],text,text,text)', 'execute')::text, 'false'
  union all select 9, 'the server role can run the new redeem function', has_function_privilege('service_role', 'public.redeem_promo_code_for_user(uuid,text[],text,text,text)', 'execute')::text, 'true'
  union all select 10, 'visitors who are not signed in can run the new create function', has_function_privilege('anon', 'public.admin_create_promo_code(text,text,integer,integer,integer,boolean,date,boolean,text,text,integer)', 'execute')::text, 'false'
  union all select 11, 'signed-in users can run the new create function (it checks the capability inside)', has_function_privilege('authenticated', 'public.admin_create_promo_code(text,text,integer,integer,integer,boolean,date,boolean,text,text,integer)', 'execute')::text, 'true'
  union all select 12, 'backfill and status functions exist', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('promo_codes_digest_pending', 'promo_codes_digest_apply', 'promo_codes_digest_mark_verified', 'promo_codes_finalise_hash_only', 'admin_promo_codes_hash_status', 'promo_codes_backfill_record'))::text, '6'
  union all select 13, 'signed-in users can run the backfill read function', has_function_privilege('authenticated', 'public.promo_codes_digest_pending(integer)', 'execute')::text, 'false'
  union all select 14, 'signed-in users can run the finalise function', has_function_privilege('authenticated', 'public.promo_codes_finalise_hash_only(boolean)', 'execute')::text, 'false'
  union all select 15, 'finalise dry run (counts only, changes nothing)', public.promo_codes_finalise_hash_only(true)::text, null
) c
order by n;
