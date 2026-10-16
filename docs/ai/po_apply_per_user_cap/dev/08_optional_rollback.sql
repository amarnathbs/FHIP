-- 08 OPTIONAL ROLLBACK of migration 0284. You normally do NOT need this.
-- The migration is additive. To stop using the per-user cap, redeploy the previous Amplify build: the previous code
-- calls the 0195 function, which still exists, and ignores the new columns. Use this file only if you want the new
-- database objects gone as well.
-- ORDER: redeploy the previous build FIRST (the current code refuses every AI reading while the v2 function is missing).
-- Dropping the user_id column discards which user each past reservation belonged to, so take file 02 first on production.

drop function if exists public.aie_reserve_ai_cost_v2(text, numeric, numeric, text, uuid, numeric);
drop index if exists public.idx_aie_ai_cost_attempt_user_day;
alter table public.aie_ai_cost_attempt drop column if exists user_id;
alter table public.aie_ai_cost_ledger drop column if exists user_daily_cap_usd;
