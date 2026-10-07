-- ROLLBACK of 0262: removes the two correction hooks (the hook on ii_reference_corrections is the only change this release made to an existing table), the monitoring functions and the events table.
-- Run rollback_0263.sql first if 0263 was applied.
drop trigger if exists trg_nav2_capture_reference_correction on public.ii_reference_corrections;
drop trigger if exists trg_nav2_capture_risk_free_correction on public.ii_risk_free_corrections;
drop function if exists public.nav2_capture_reference_correction();
drop function if exists public.nav2_capture_risk_free_correction();
drop function if exists public.nav2_monitoring_snapshot();
drop function if exists public.nav2_monitor_cell(bigint, boolean);
drop table if exists public.nav2_correction_events;
