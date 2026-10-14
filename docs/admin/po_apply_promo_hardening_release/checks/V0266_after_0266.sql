-- V0266 check after migration 0266 (read only, safe to run any number of times)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'e-mail request start functions (the old one plus the new one)' as check_name, (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_promo_email_begin')::text as actual, '2' as expected
  union all select 2, 'new function has no default values (so the old three argument call cannot reach it)', (select pronargdefaults from pg_proc where oid = to_regprocedure('public.admin_promo_email_begin(text,integer,boolean,text,text,uuid)'))::text, '0'
  union all select 3, 'limit: recipients per admin per day', public.promo_email_limits() ->> 'admin_recipients_per_day', '100'
  union all select 4, 'limit: recipients across all admins per day', public.promo_email_limits() ->> 'global_recipients_per_day', '300'
  union all select 5, 'limit: replacements per code per day', public.promo_email_limits() ->> 'replacements_per_code_per_day', '3'
  union all select 6, 'alert at this percent of a daily limit', public.promo_email_limits() ->> 'volume_alert_percent', '80'
  union all select 7, 'provider failures in a row before sending pauses', public.promo_email_limits() ->> 'circuit_failure_threshold', '5'
  union all select 8, 'minutes sending pauses', public.promo_email_limits() ->> 'circuit_open_minutes', '15'
  union all select 9, 'new columns on the e-mail request table', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'promo_email_requests' and column_name in ('purpose', 'kind', 'replaces_promo_code_id'))::text, '3'
  union all select 10, 'earlier e-mail requests are all marked as create', (select count(*) from public.promo_email_requests where kind <> 'create')::text, '0'
  union all select 11, 'circuit breaker table exists', (to_regclass('public.promo_email_circuit') is not null)::text, 'true'
  union all select 12, 'request status function exists', (to_regprocedure('public.admin_promo_email_request_status(text,text[])') is not null)::text, 'true'
  union all select 13, 'signed-in users can run the breaker report function', has_function_privilege('authenticated', 'public.promo_email_circuit_report(boolean)', 'execute')::text, 'false'
) c
order by n;
