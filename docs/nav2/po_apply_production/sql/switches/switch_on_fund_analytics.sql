-- Turns the Fund analytics report ON for every Premium person. Do this only when the README says so (pilot step), never before the smoke checks pass.
-- It does not start any price fetching: the planner, the correction worker, the weekly refresh and the hydration have their own switches.
update public.ii_reference_job_control
set enabled = true, disabled_reason = null, updated_at = now()
where job_key = 'nav2_fund_analytics';
