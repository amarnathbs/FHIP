-- ROLLBACK for 0261 step 2 of 2: run rollback_0261_restore_0219_function.sql FIRST, then this.
-- Drops the four fund analytics report tables. WARNING: this discards every issued Fund analytics report. Do not run it without the Product Owner.
-- Run rollback_0262.sql and rollback_0269.sql first if they were applied.
drop table if exists public.nav2_report_render_tokens;
drop table if exists public.nav2_report_nav_dependencies;
drop table if exists public.nav2_result_cache;
drop table if exists public.nav2_fund_analytics_reports;
drop function if exists public.nav2_reports_immutable();
