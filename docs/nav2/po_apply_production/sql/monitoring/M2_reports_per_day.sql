-- M2 (read only). Reports per day and per size during the pilot: how many were made each day, by how many people, and the largest and the average number of funds.
-- Aggregate only. Use it to decide whether to keep the pilot limit of 10 funds per report (a run of days with many large reports is the signal to measure timing before any change).
select
  (created_at at time zone 'Asia/Kolkata')::date as day_india,
  count(*) as reports,
  count(distinct user_id) as people,
  max(scheme_count) as largest_report_in_funds,
  round(avg(scheme_count), 1) as average_funds
from public.nav2_fund_analytics_reports
where created_at > now() - interval '30 days'
group by 1
order by 1 desc;
