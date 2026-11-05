-- ROLLBACK. Stops the automatic RBI refresh completely. Nothing already stored is deleted or changed. Safe to run twice.
-- 1. remove the two schedules if they exist
select cron.unschedule(jobname)
  from cron.job
 where jobname in ('nav2-risk-free-refresh-wed', 'nav2-risk-free-refresh-thu-fri');
-- 2. switch the job off (a reason is mandatory when switching off)
update public.ii_reference_job_control
   set enabled = false, disabled_reason = 'weekly RBI refresh switched off by the Product Owner, see docs/nav2/po_apply_weekly_refresh.', updated_at = now()
 where job_key = 'nav2_risk_free_weekly_refresh';
