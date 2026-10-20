-- O03 WRITE. DEV ONLY (address bar must show project vqycarelcoijzwlpkpcz). NEVER run this on production.
-- Purpose: show the per-user cap refusing before the provider, with no real spend. A reading of one bank statement reserves about
-- 0.009 dollars, so a cap of 0.001 refuses it. The cap is one value for EVERY user, so on production this would refuse all real people.
-- Restore with O02b immediately after the check.

update public.aie_ai_cost_ledger set user_daily_cap_usd = 0.001 where id = 'global';

select id, user_daily_cap_usd as per_user_daily_cap_usd, allowance_usd as global_allowance_usd
  from public.aie_ai_cost_ledger
 where id = 'global';
