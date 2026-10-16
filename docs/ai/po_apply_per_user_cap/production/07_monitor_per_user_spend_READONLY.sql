-- 07 MONITOR per-user AI spend today (UTC day). READ ONLY. Counts and amounts only, no document content.
-- Only the first 8 characters of each user id are shown. Run it whenever you want to see who is near the daily cap.

select left(user_id::text, 8) as user_prefix,
       count(*) as attempts_today,
       count(*) filter (where admission_outcome = 'admitted') as admitted,
       count(*) filter (where admission_outcome = 'user_daily_cap_reached') as refused_daily_cap,
       round(sum(coalesce(settled_usd, reserved_usd)), 6) as counted_usd_today
from public.aie_ai_cost_attempt
where user_id is not null
  and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
group by user_id
order by counted_usd_today desc
limit 25;

-- The day boundary the cap uses, so the numbers above can be read correctly.
select date_trunc('day', now() at time zone 'utc') at time zone 'utc' as utc_day_started_at, now() as now_utc;
