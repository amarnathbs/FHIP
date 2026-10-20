-- LATER STAGE (not at release). Turns the fund analytics required window planner ON for the existing price history fetch of each person own funds.
-- Off means exactly the behaviour production has today. Read README stage B before using this.
update public.ii_reference_job_control
set enabled = true, disabled_reason = null, updated_at = now()
where job_key = 'nav2_trigger_planner';
