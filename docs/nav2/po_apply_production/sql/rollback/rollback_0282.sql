-- ROLLBACK of 0282: removes the count of statement lines held back for review. Only this function is affected.
drop function if exists public.nav2_ambiguity_case_summary();
