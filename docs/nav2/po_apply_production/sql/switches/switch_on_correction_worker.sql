-- LATER STAGE (not at release). Turns the correction worker ON. It only does something when a cron schedule calls it and a price or rate was corrected.
-- Read README stage C before using this.
update public.ii_reference_job_control
set enabled = true, disabled_reason = null, updated_at = now()
where job_key = 'nav2_correction_worker';
