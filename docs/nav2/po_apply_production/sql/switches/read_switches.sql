-- Read only. The state of every switch fund analytics uses, plus the existing price fetch switch. Paste the rows back.
select job_key, enabled, left(coalesce(disabled_reason, ''), 70) as reason_start, updated_at
from public.ii_reference_job_control
where job_key in ('nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh', 'pc6_selective_historical_hydration')
order by job_key;
