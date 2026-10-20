-- ROLLBACK of 0260 (all five parts). WARNING: this discards the loaded RBI rates and their audit ledger, and the two fund analytics permissions. Do not run it without the Product Owner.
-- Run the 0261, 0262, 0263 and 0269 rollbacks first (0262 reads tables made here).
drop function if exists public.commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date);
drop function if exists public.record_risk_free_refresh_results(text, jsonb, jsonb, date);
drop function if exists public.resolve_risk_free_review_item(uuid, text, text);
drop function if exists public.correct_risk_free_observation(text, date, numeric, text);
drop function if exists public.set_risk_free_series_state(text, boolean, text, text);
drop table if exists public.ii_risk_free_series_state_log;
drop table if exists public.ii_risk_free_corrections;
drop table if exists public.ii_risk_free_review_items;
drop table if exists public.ii_risk_free_observations;
drop table if exists public.ii_risk_free_batches;
drop table if exists public.ii_risk_free_series;
drop function if exists public.ii_risk_free_append_only();
drop function if exists public.ii_risk_free_obs_guard();
drop function if exists public.is_risk_free_data_admin();
drop function if exists public.is_risk_free_series_switch_admin();
alter table public.admin_users drop column if exists can_upload_risk_free_data;
alter table public.admin_users drop column if exists can_switch_risk_free_series;
delete from public.ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker');
