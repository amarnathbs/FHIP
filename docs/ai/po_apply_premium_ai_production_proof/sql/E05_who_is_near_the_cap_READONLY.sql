-- E05 READ-ONLY. Who spent what today (UTC day), first 8 characters of the id only. Use it to see the cap working.
select left(user_id::text, 8) as user_prefix,
       count(*) as attempts_today,
       count(*) filter (where admission_outcome = 'admitted') as admitted,
       count(*) filter (where admission_outcome = 'user_daily_cap_reached') as refused_daily_cap,
       count(*) filter (where admission_outcome = 'budget_exhausted') as refused_global,
       round(sum(coalesce(settled_usd, reserved_usd)), 6) as counted_usd_today
  from aie_ai_cost_attempt
 where user_id is not null
   and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
 group by user_id
 order by counted_usd_today desc
 limit 25;
