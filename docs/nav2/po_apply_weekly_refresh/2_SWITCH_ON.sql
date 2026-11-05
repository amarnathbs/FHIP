-- Step 2. Turns the weekly RBI refresh switch ON. On its own this does NOTHING yet: no schedule exists, and every manual call is a DRY RUN
-- (reads RBI, writes nothing) unless the request says dryRun false explicitly. Safe to run. Rollback: ROLLBACK_switch_off_and_unschedule.sql.
update public.ii_reference_job_control
   set enabled = true, disabled_reason = null, updated_at = now()
 where job_key = 'nav2_risk_free_weekly_refresh';
