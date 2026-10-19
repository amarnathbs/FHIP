-- A02 READ-ONLY. The spend ceilings that bound the AI reading, and how many people it is open to. Counts and amounts only.
-- The global allowance is a LIFETIME ledger: settled_usd has no reset. The per-user cap resets every UTC day.
-- The effective global ceiling is the smaller of the stored allowance_usd and the AIE_AI_COST_ALLOWANCE_USD setting.

select l.allowance_usd as global_allowance_usd_stored,
       l.reserved_usd,
       l.settled_usd,
       (l.allowance_usd - l.reserved_usd - l.settled_usd) as global_remaining_usd,
       l.user_daily_cap_usd as per_user_daily_cap_usd,
       l.total_attempts,
       l.total_input_tokens,
       l.total_output_tokens,
       (select count(*) from aie_ai_cost_attempt a where a.settled_at is null and a.reserved_usd > 0 and a.created_at < now() - interval '1 hour') as reservations_open_over_1h,
       (select count(*) from user_entitlements e
         where e.plan_tier = 'premium'
           and (e.effective_from is null or e.effective_from <= current_date)
           and (e.effective_to is null or e.effective_to >= current_date)) as premium_active_today,
       (select count(*) from user_entitlements) as entitlement_rows_total,
       date_trunc('day', now() at time zone 'utc') at time zone 'utc' as utc_day_started_at
  from aie_ai_cost_ledger l
 where l.id = 'global';
