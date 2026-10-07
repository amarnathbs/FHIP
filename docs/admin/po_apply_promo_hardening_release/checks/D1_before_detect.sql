-- D1 detection pack: read only, safe to run on DEV and on production, any number of times
-- Paste the whole file in the SQL editor and press Run. You get one row per check.
-- Section A: the database is in the state this release was built against (ok must be true).
-- Section B: the five old functions are exactly the text the repository says they are (ok must be true).
-- Section C: nothing of this release is applied yet (every row must say false before you apply, and ok true).
-- Section D and F: facts for the record. They have no expected value, so ok is true. Copy them to your reply.
-- Section E: the environment marker. At most one row is allowed.
-- If any ok is false in section A, B or E: STOP. Do not apply anything. Send the result back.

select section, check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'A' as section, 'promo code table exists' as check_name, (to_regclass('public.promo_codes') is not null)::text as actual, 'true' as expected
  union all select 2, 'A', 'promo redemption table exists', (to_regclass('public.promo_code_redemptions') is not null)::text, 'true'
  union all select 3, 'A', 'reminder ledger table exists', (to_regclass('public.premium_expiry_email_ledger') is not null)::text, 'true'
  union all select 4, 'A', 'e-mail send ledger table exists', (to_regclass('public.promo_email_sends') is not null)::text, 'true'
  union all select 5, 'A', 'Premium grant audit table exists', (to_regclass('public.admin_entitlement_events') is not null)::text, 'true'
  union all select 6, 'A', 'address binding column exists', ((select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'bound_email_hash'))::text, 'true'
  union all select 7, 'A', 'old function exists: create (old, 9 arguments)', (to_regprocedure('public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)') is not null)::text, 'true'
  union all select 8, 'A', 'old function exists: list (old, returns the plain code)', (to_regprocedure('public.admin_list_promo_codes()') is not null)::text, 'true'
  union all select 9, 'A', 'old function exists: redeem (old, 4 arguments)', (to_regprocedure('public.redeem_promo_code_for_user(uuid,text,text,text)') is not null)::text, 'true'
  union all select 10, 'A', 'old function exists: grant (old, 4 arguments)', (to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text)') is not null)::text, 'true'
  union all select 11, 'A', 'old function exists: e-mail request start (old, 3 arguments)', (to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)') is not null)::text, 'true'
  union all select 12, 'B', 'old function text matches the repository: create (old, 9 arguments)', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.admin_create_promo_code(text,integer,integer,boolean,date,boolean,text,text,integer)')), '1c64e48f4d90ee00e7c708279df4bdcc'
  union all select 13, 'B', 'old function text matches the repository: list (old, returns the plain code)', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.admin_list_promo_codes()')), '86249669c47a9b04a4bddce9fca9b49c'
  union all select 14, 'B', 'old function text matches the repository: redeem (old, 4 arguments)', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.redeem_promo_code_for_user(uuid,text,text,text)')), 'd5b4500127fb82ca0aad29c60ae5279a'
  union all select 15, 'B', 'old function text matches the repository: grant (old, 4 arguments)', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.admin_manage_premium_entitlement(text,uuid,date,text)')), 'b0372d2e952ddf299dae33cfefe12fb6'
  union all select 16, 'B', 'old function text matches the repository: e-mail request start (old, 3 arguments)', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)')), '658e18456e49ab2e43da54ebc961625d'
  union all select 17, 'C', 'digest column exists (false before you apply)', ((select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'code_digest'))::text, 'false'
  union all select 18, 'C', 'new list function exists (false before you apply)', (to_regprocedure('public.admin_list_promo_codes_v2()') is not null)::text, 'false'
  union all select 19, 'C', 'override capability column exists (false before you apply)', ((select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name = 'can_override_entitlement_limits'))::text, 'false'
  union all select 20, 'C', 'retention policy table exists (false before you apply)', (to_regclass('public.promo_retention_policy') is not null)::text, 'false'
  union all select 21, 'C', 'monitoring table exists (false before you apply)', (to_regclass('public.admin_monitoring_events') is not null)::text, 'false'
  union all select 22, 'D', 'promo codes in total', (select count(*) from public.promo_codes)::text, null
  union all select 23, 'D', 'promo codes that hold their text', (select count(*) from public.promo_codes where code is not null)::text, null
  union all select 24, 'D', 'promo codes bound to an address', (select count(*) from public.promo_codes where bound_email_hash is not null)::text, null
  union all select 25, 'D', 'promo codes that are active', (select count(*) from public.promo_codes where status = 'active')::text, null
  union all select 26, 'D', 'promo redemptions in total', (select count(*) from public.promo_code_redemptions)::text, null
  union all select 27, 'D', 'people on an active admin grant', (select count(*) from public.user_entitlements where entitlement_source = 'admin_grant' and plan_tier = 'premium' and effective_to >= current_date)::text, null
  union all select 28, 'D', 'people on an active promo code entitlement', (select count(*) from public.user_entitlements where entitlement_source = 'promo_code' and plan_tier = 'premium' and effective_to >= current_date)::text, null
  union all select 29, 'D', 'people on paid Premium', (select count(*) from public.user_entitlements where entitlement_source = 'payment' and plan_tier = 'premium')::text, null
  union all select 30, 'D', 'admin grant audit rows', (select count(*) from public.admin_entitlement_events)::text, null
  union all select 31, 'D', 'e-mail requests so far', (select count(*) from public.promo_email_requests)::text, null
  union all select 32, 'D', 'people who hold the Premium grant capability', (select count(*) from public.admin_users where can_manage_premium_entitlements)::text, null
  union all select 33, 'D', 'people who hold the promo code capability', (select count(*) from public.admin_users where can_manage_promo_codes)::text, null
  union all select 34, 'E', 'environment marker rows', (select count(*) from public.platform_deployment_environment)::text, null
  union all select 35, 'E', 'environment marker value', (select coalesce(string_agg(environment, ', '), 'none') from public.platform_deployment_environment), null
  union all select 36, 'E', 'at most one environment marker row (needed by 0268)', ((select count(*) from public.platform_deployment_environment) <= 1)::text, 'true'
  union all select 37, 'F', 'job switches', (select coalesce(string_agg(job_key || '=' || enabled::text, ', ' order by job_key), 'none') from public.premium_reminder_job_control), null
) c
order by n;
