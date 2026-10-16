-- 10 CHANGE THE DAILY CAP LATER. Not part of the roll-out. Run it only when you decide a different limit.
-- The stored column is the single source of truth for the per-user daily cap. Changing it needs no deploy and takes
-- effect on the next AI reading. The value is in US dollars per user per UTC day. Zero refuses every AI reading.
-- Edit the number on the next line before you run it. Then run the check at the bottom.

update public.aie_ai_cost_ledger set user_daily_cap_usd = 1.00 where id = 'global';

select id, user_daily_cap_usd as per_user_daily_cap_usd, allowance_usd as global_allowance_usd
from public.aie_ai_cost_ledger
where id = 'global';
