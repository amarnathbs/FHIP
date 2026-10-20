-- Emergency stop: turns all four fund analytics switches OFF. Nothing is deleted. The old behaviour of the application is unchanged by this.
update public.ii_reference_job_control
set enabled = false, disabled_reason = 'fund analytics switched off by the Product Owner, see the release notes.', updated_at = now()
where job_key in ('nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh');
