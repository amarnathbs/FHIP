-- Read only, after the first Premium person has generated a report. Aggregate only: no names, no report content.
-- Expect reports_total at least 1, and price_rows_added_by_nav2 is not a figure here because fund analytics adds no price rows while its fetch switches are off.
select
  (select count(*) from public.nav2_fund_analytics_reports) as reports_total,
  (select count(distinct user_id) from public.nav2_fund_analytics_reports) as people_with_a_report,
  (select count(*) from public.nav2_result_cache where invalidated_at is null) as live_cache_entries,
  (select count(*) from public.nav2_correction_events where processed_at is null) as unprocessed_correction_events,
  (select count(*) from public.ii_risk_free_observations where kind = 'value') as risk_free_value_rows;
