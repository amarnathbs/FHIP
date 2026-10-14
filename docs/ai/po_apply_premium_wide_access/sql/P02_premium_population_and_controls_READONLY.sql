-- P02  READ-ONLY  How many people this change opens AI document reading to, and the live controls that still bound it.
-- No personal data is selected: counts and control values only.

select
  (select count(*) from user_entitlements
    where plan_tier = 'premium'
      and (effective_from is null or effective_from <= current_date)
      and (effective_to is null or effective_to >= current_date)) as premium_active_today,
  (select count(*) from user_entitlements
    where plan_tier = 'premium'
      and effective_to is not null and effective_to between current_date and current_date + 7) as premium_ending_within_7_days,
  (select count(*) from user_entitlements where plan_tier = 'premium') as premium_rows_total_any_window,
  (select count(*) from user_entitlements) as entitlement_rows_total;

-- Run the next statement SEPARATELY (the editor shows only the last result).
-- Module 11 platform controls (zero-cost insights and explanations). Defaults are enabled with Premium required.
select ai_globally_enabled, custom_ai_enabled, standard_requires_premium,
       monthly_custom_question_allowance, rate_limit_max_requests, rate_limit_window_seconds,
       per_user_monthly_cost_ceiling_usd, platform_monthly_cost_ceiling_usd, max_cost_per_request_usd
  from ai_platform_controls
 where id = 'global';
