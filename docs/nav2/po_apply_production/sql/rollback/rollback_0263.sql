-- ROLLBACK of 0263: removes the weekly refresh attempt log and its summary function. Only fund analytics objects are affected.
drop function if exists public.nav2_refresh_attempt_summary();
drop table if exists public.ii_risk_free_refresh_attempts;
