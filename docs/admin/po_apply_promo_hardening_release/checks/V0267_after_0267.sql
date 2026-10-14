-- V0267 check after migration 0267 (read only, safe to run any number of times)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.
-- The cleanup job ships switched OFF. Row 3 must read false for both switches until you decide otherwise.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'retention periods (data set, days, action)' as check_name,
         (select string_agg(data_set || ':' || retention_days::text || ':' || action, ', ' order by data_set) from public.promo_retention_policy) as actual,
         'premium_expiry_email_ledger:400:delete, promo_code_events:2555:anonymise, promo_codes:365:anonymise, promo_email_requests:180:delete, promo_email_sends:180:anonymise, promo_redemption_attempts:30:delete' as expected
  union all select 2, 'legal holds that are open', (select count(*) from public.promo_retention_holds where released_at is null)::text, '0'
  union all select 3, 'job switches (all must be off)', (select string_agg(job_key || '=' || enabled::text, ', ' order by job_key) from public.premium_reminder_job_control), 'expiry_email=false, promo_retention=false'
  union all select 4, 'cleanup runs recorded so far', (select count(*) from public.promo_retention_runs)::text, null
  union all select 5, 'signed-in users can run the cleanup function', has_function_privilege('authenticated', 'public.promo_retention_run(boolean,timestamp with time zone)', 'execute')::text, 'false'
  union all select 6, 'new anonymised columns exist (send ledger and event trail)', (select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('promo_email_sends', 'promo_code_events') and column_name = 'anonymised_at')::text, '2'
  union all select 7, 'the event trail still refuses ordinary updates (trigger attached)', (select count(*) from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal)::text, '2'
) c
order by n;
