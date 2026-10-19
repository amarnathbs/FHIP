-- O01 WRITE. Change the GLOBAL AI spending ceiling (US dollars, for the whole life of the platform, nothing resets it).
-- The stored allowance_usd is the real ceiling. The AIE_AI_COST_ALLOWANCE_USD setting can only LOWER it, never raise it.
-- Run A02 first and note the numbers. This file takes a one-row backup copy the first time, then changes the figure.
-- Edit the number on the update line. The check at the end shows the result.

create schema if not exists private;
create table if not exists private.bkp_aiops_ledger as table public.aie_ai_cost_ledger;
alter table private.bkp_aiops_ledger enable row level security;
revoke all on private.bkp_aiops_ledger from public, anon, authenticated;

update public.aie_ai_cost_ledger set allowance_usd = 10.00 where id = 'global';

select id, allowance_usd, reserved_usd, settled_usd, (allowance_usd - reserved_usd - settled_usd) as remaining_usd, user_daily_cap_usd
  from public.aie_ai_cost_ledger
 where id = 'global';
