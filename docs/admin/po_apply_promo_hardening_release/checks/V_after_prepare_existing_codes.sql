-- V-prepare check after the Prepare existing codes button on the Promo Codes page (read only, safe to repeat)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.
-- Nothing is removed by the button: every existing code still has its text and now also a verified protected copy.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'promo codes in total' as check_name, (select count(*) from public.promo_codes)::text as actual, null as expected
  union all select 2, 'codes that still hold their text', (select count(*) from public.promo_codes where code is not null)::text, null
  union all select 3, 'codes with a verified protected copy', (select count(*) from public.promo_codes where code_digest_verified_at is not null)::text, null
  union all select 4, 'codes that hold their text but have NO verified protected copy', (select count(*) from public.promo_codes where code is not null and code_digest_verified_at is null)::text, '0'
  union all select 5, 'two codes share one protected copy (must never happen)', (select count(*) from (select code_digest from public.promo_codes where code_digest is not null group by code_digest having count(*) > 1) d)::text, '0'
  union all select 6, 'evidence rows written by the button', (select count(*) from public.admin_monitoring_events where event_type = 'promo_codes_digest_backfill')::text, null
) c
order by n;
