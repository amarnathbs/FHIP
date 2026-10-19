-- O02a WRITE. EMERGENCY STOP of all new AI document spending, without a deploy and without dropping anything.
-- Setting the per-user daily cap to zero makes the database refuse every new AI reading before the provider is called.
-- Existing drafts, review, acceptance, deterministic imports and manual entry are untouched. The cap objects stay in place.
-- Undo it with O02b. Takes effect on the next AI reading.

update public.aie_ai_cost_ledger set user_daily_cap_usd = 0 where id = 'global';

select id, user_daily_cap_usd as per_user_daily_cap_usd, allowance_usd as global_allowance_usd
  from public.aie_ai_cost_ledger
 where id = 'global';
