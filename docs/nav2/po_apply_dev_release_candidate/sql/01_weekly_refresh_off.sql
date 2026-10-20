-- 01 (writes ONE row, safe to run twice). Makes sure the weekly RBI refresh switch is OFF.
-- It changes nothing if the switch is already OFF. On DEV it was OFF when this pack was written (DEV test finished), so this is a belt and braces step.
-- Run 00_state_readonly.sql afterwards and read the switches column.
update public.ii_reference_job_control
set enabled = false,
    disabled_reason = 'Weekly RBI refresh stays OFF until the final-build dry run has passed and the pilot gate is open.',
    updated_at = now()
where job_key = 'nav2_risk_free_weekly_refresh' and enabled is distinct from false;
