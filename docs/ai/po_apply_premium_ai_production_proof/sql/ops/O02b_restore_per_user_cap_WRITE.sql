-- O02b WRITE. Restore the per-user daily cap after O02a (or after any temporary test). US dollars per user per UTC day.
-- Edit the number to the value shown by A02 BEFORE you changed it (the agreed default is 1.00). Takes effect on the next AI reading.

update public.aie_ai_cost_ledger set user_daily_cap_usd = 1.00 where id = 'global';

select id, user_daily_cap_usd as per_user_daily_cap_usd, allowance_usd as global_allowance_usd
  from public.aie_ai_cost_ledger
 where id = 'global';
