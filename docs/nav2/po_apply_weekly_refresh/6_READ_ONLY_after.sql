-- READ ONLY. Changes nothing. Run after step 5, and again after the first Wednesday run. Paste the rows back to me.
select 'cron job' as what, jobname || ' | ' || schedule || ' | active=' || active::text as detail
  from cron.job
 where starts_with(jobname, 'nav2-risk-free-refresh')
union all
select 'switch', 'enabled=' || enabled::text || ' | last_success=' || coalesce(last_success_at::text, 'never') || ' | last_failure=' || coalesce(last_failure_at::text, 'never') || ' | consecutive_failures=' || consecutive_failures::text
  from public.ii_reference_job_control
 where job_key = 'nav2_risk_free_weekly_refresh'
union all
select 'step row', expected_auction_date::text || ' | ' || step || ' | decided=' || coalesce(decided_live_at::text, 'no') || ' | wait_until=' || coalesce(retry_not_before::text, 'none') || ' | pages=' || (evidence -> 'counts' ->> 'pages') || ' robots=' || (evidence -> 'counts' ->> 'robots')
  from (select * from public.ii_risk_free_refresh_stage order by expected_auction_date desc limit 3) st
union all
select 'series row', observation_date::text || ' | ' || kind || ' | ' || coalesce(value_percent::text, 'gap') || ' | ' || entry_kind
  from (select * from public.ii_risk_free_observations where series_id = 'RBI_91D_TBILL_CUTOFF_YIELD' order by observation_date desc limit 4) s
union all
select 'attempt', attempted_at::text || ' | ' || source_status || ' | tbill=' || coalesce(tbill_outcome, '-') || ' | repo=' || coalesce(repo_outcome, '-') || ' | pages=' || pages_requested::text
  from (select * from public.ii_risk_free_refresh_attempts order by attempted_at desc limit 3) a;
