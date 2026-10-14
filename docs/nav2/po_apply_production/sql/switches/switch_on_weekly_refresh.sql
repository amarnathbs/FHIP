-- LATER STAGE (not at release, and only after the final-build dry run has passed and the cron configuration, failure alerting and idempotency are checked). Written RBI confirmation is not required by Product Owner decision. Turns the weekly RBI refresh ON. It starts as a dry run that writes nothing.
-- Read README stage D before using this.
update public.ii_reference_job_control
set enabled = true, disabled_reason = null, updated_at = now()
where job_key = 'nav2_risk_free_weekly_refresh';
