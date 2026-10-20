-- M1 (read only). Pilot health, one row of counts. Run it after the first reports and then once a day during the pilot. No names, no report content.
-- Read it like this: duplicate_idempotency_keys must stay 0 (the database enforces it). reports_without_key counts reports made before 0281 or by an old client and
-- should not grow once the pilot runs on the new code. unprocessed_correction_events is only above 0 while a correction is waiting and the worker is OFF (harmless: a
-- corrected price changes the cache key by itself). widest_report is the largest number of funds in one report: it must never be above 10 during the pilot.
select
  (select count(*) from public.nav2_fund_analytics_reports) as reports_total,
  (select count(*) from public.nav2_fund_analytics_reports where created_at > now() - interval '24 hours') as reports_last_24h,
  (select count(distinct user_id) from public.nav2_fund_analytics_reports) as people_with_a_report,
  (select coalesce(max(scheme_count), 0) from public.nav2_fund_analytics_reports) as widest_report,
  (select count(*) from public.nav2_fund_analytics_reports where idempotency_key is null) as reports_without_key,
  (select count(*) from (select user_id, idempotency_key from public.nav2_fund_analytics_reports where idempotency_key is not null group by user_id, idempotency_key having count(*) > 1) d) as duplicate_idempotency_keys,
  (select count(*) from public.nav2_result_cache where invalidated_at is null) as live_cache_entries,
  (select count(*) from public.nav2_correction_events where processed_at is null) as unprocessed_correction_events,
  (select count(*) from public.ii_risk_free_observations where kind = 'value') as risk_free_value_rows,
  (select string_agg(job_key || '=' || enabled::text, ', ' order by job_key) from public.ii_reference_job_control where left(job_key, 4) = 'nav2' or job_key = 'pc6_selective_historical_hydration') as switches;
