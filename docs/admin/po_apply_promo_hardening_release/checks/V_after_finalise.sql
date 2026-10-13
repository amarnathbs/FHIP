-- V-finalise check after the finalise step removed the stored code text (read only, safe to repeat)
-- Paste the whole file in the SQL editor and press Run. The column ok must say true on every row.

select check_name, actual, expected, coalesce(expected is null or actual = expected, false) as ok
from (
  select 1 as n, 'codes that still hold their text' as check_name, (select count(*) from public.promo_codes where code is not null)::text as actual, '0' as expected
  union all select 2, 'codes with no identity at all (no text, no protected copy, not anonymised)', (select count(*) from public.promo_codes where code is null and code_digest is null and anonymised_at is null)::text, '0'
  union all select 3, 'codes with a verified protected copy', (select count(*) from public.promo_codes where code_digest_verified_at is not null)::text, null
  union all select 4, 'finalise evidence rows', (select count(*) from public.admin_monitoring_events where event_type = 'promo_codes_hash_only_finalised')::text, null
) c
order by n;
