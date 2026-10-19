-- Turns the Fund analytics report OFF again. Nothing is deleted: stored reports stay, people see the plain not available yet sentence.
update public.ii_reference_job_control
set enabled = false, disabled_reason = 'Fund analytics switched off by the Product Owner after release, see the release notes.', updated_at = now()
where job_key = 'nav2_fund_analytics';
