-- Starter recommendation library (~19 rows across all 9 categories). Written
-- generically enough to apply across scenarios; the user will review and can
-- add/edit further entries via the admin UI (task #152) as real-world
-- parameter combinations surface additional cases. All conditions reference
-- the flat evaluation context built by lib/services/recommendationsData.ts's
-- buildEvaluationContext() — see lib/engines/recommendations/matcher.ts for
-- the AND-across-groups/OR-within-group evaluation rule.

insert into action_recommendation_master
  (recommendation_code, title, category, description, action_text, impact_type, impact_formula_notes, priority, is_premium, status)
values
  ('debt_high_credit_utilization', 'High credit card utilisation', 'debt',
   'Your credit card balance is a large share of your available credit limit, which typically carries a high interest rate and can affect credit scoring.',
   'Prioritise paying down credit card balances before other discretionary spending, and consider consolidating to a lower-rate facility if utilisation stays high.',
   'qualitative', null, 80, false, 'active'),

  ('debt_off_track_variance', 'Debt repayment falling behind plan', 'debt',
   'Your actual outstanding debt balance is behind what your forecast expected by this point.',
   'Review your repayment schedule and consider directing any spare surplus toward the debt with the highest interest rate first.',
   'qualitative', null, 70, false, 'active'),

  ('debt_extra_repayment_opportunity', 'Spare surplus available to accelerate debt payoff', 'debt',
   'You have outstanding debt and a positive disposable income each month that is not committed elsewhere.',
   'Consider directing part of your disposable income toward additional debt repayments to reduce total interest paid and shorten the payoff timeline.',
   'estimated_amount', 'You currently have {{dashboard.disposableIncome}} in disposable income each month after essential expenses and debt repayments.', 60, false, 'active'),

  ('retirement_material_gap', 'Retirement funding gap', 'retirement',
   'Your projected retirement balance is tracking below the corpus required to fund your stated retirement income target.',
   'Consider increasing your regular retirement contribution, reviewing your target retirement age, or adjusting your desired retirement income.',
   'estimated_amount', '{{retirement.fundingGap}} is the current projected gap between your required retirement corpus and your projected balance at retirement.', 90, false, 'active'),

  ('retirement_depletion_risk', 'Retirement savings projected to deplete', 'retirement',
   'At the current withdrawal rate and contribution settings, your retirement balance is projected to run out before the end of the forecast horizon.',
   'Consider a lower withdrawal rate, a later retirement age, or a higher contribution rate to extend how long your retirement savings last.',
   'estimated_months', '{{retirement.depletionMonth}} is the forecast month at which your retirement balance is projected to reach zero.', 95, false, 'active'),

  ('resilience_low_emergency_fund', 'Emergency fund below the planning reference', 'resilience',
   'Your liquid reserves currently cover fewer months of essential expenses than the standard 6-month planning reference.',
   'Consider directing part of your monthly surplus into a liquid cash or high-interest savings account until you reach a 6-month buffer.',
   'estimated_months', '{{dashboard.emergencyFundMonths}} months of essential expenses are currently covered by your liquid reserves.', 85, false, 'active'),

  ('resilience_depletion_during_shock', 'Limited resilience to an income or expense shock', 'resilience',
   'Under a modelled stress scenario (income loss, unexpected expense, or similar), your liquid reserves are projected to be depleted before recovery.',
   'Building a larger liquid buffer, or reviewing insurance cover for the specific risk modelled, would improve resilience to this kind of shock.',
   'estimated_months', 'Liquid reserves are projected to deplete by month {{resilience.depletionMonth}} of the modelled stress scenario.', 75, false, 'active'),

  ('resilience_no_insurance_recorded', 'No insurance cover recorded', 'resilience',
   'No insurance policies are recorded for your household, which leaves income, health, or asset risks unmitigated in a shock scenario.',
   'Review your insurance needs (income protection, health, home and contents, life) and record any existing cover, or consider taking out cover for material gaps.',
   'qualitative', null, 50, false, 'active'),

  ('cash_flow_negative_surplus', 'Monthly expenses exceed income', 'cash_flow',
   'Your recorded monthly expenses and debt repayments currently exceed your income, producing a negative monthly surplus.',
   'Review discretionary expenses for reductions, and check whether any income sources are missing or under-recorded.',
   'estimated_amount', 'Your current monthly surplus is {{dashboard.monthlySurplus}}.', 100, false, 'active'),

  ('cash_flow_low_savings_rate', 'Savings rate below 10% of income', 'cash_flow',
   'Less than 10% of your net income is currently being retained as surplus each month.',
   'Look for opportunities to increase your savings rate toward a 20% target, either by reducing lifestyle spending or increasing income.',
   'qualitative', null, 55, false, 'active'),

  ('cash_flow_high_discretionary', 'High discretionary spending share', 'cash_flow',
   'More than half of your income is going toward lifestyle (non-essential) spending.',
   'Review your lifestyle expense categories for the largest discretionary items and consider reallocating some toward savings or debt repayment.',
   'qualitative', null, 45, false, 'active'),

  ('net_worth_off_track', 'Net worth tracking below forecast', 'net_worth',
   'Your actual net worth is behind what your forecast expected by the comparison date.',
   'Review the Consolidated Variance section for which category (assets, investments, debt) is driving the gap, and address that category directly.',
   'qualitative', null, 65, false, 'active'),

  ('net_worth_low_liquidity', 'Very low share of liquid assets', 'net_worth',
   'Only a small share of your total assets are held in liquid form (cash or equivalents), which can limit flexibility in a shock.',
   'Consider whether some less-liquid holdings could be rebalanced toward cash or liquid investments to improve flexibility.',
   'qualitative', null, 40, false, 'active'),

  ('net_worth_property_concentration', 'High concentration in property', 'net_worth',
   'A large majority of your assets are concentrated in property, which can increase exposure to a single asset class.',
   'Consider whether diversifying future contributions into other asset classes (equities, fixed interest) would reduce concentration risk over time.',
   'qualitative', null, 35, false, 'active'),

  ('goal_off_track', 'One or more goals behind schedule', 'goal',
   'Your recorded goal progress is behind what your forecast expected by the comparison date.',
   'Review the Goal Forecasts section for the specific goal(s) affected and consider increasing contributions or adjusting the target date.',
   'qualitative', null, 60, false, 'active'),

  ('investment_start_investing_surplus', 'Surplus available but no investments recorded', 'investment',
   'You have a positive monthly surplus but no investment holdings currently recorded.',
   'Consider directing part of your monthly surplus into a diversified investment (e.g. a low-cost index fund) rather than leaving it uninvested.',
   'estimated_amount', 'You currently have {{dashboard.monthlySurplus}} in monthly surplus that is not directed to any recorded investment.', 55, false, 'active'),

  ('cross_border_fx_exposure', 'Assets held across multiple countries', 'cross_border',
   'You hold recorded assets, investments or liabilities in more than one country, which introduces currency exchange rate exposure.',
   'Review the Cross-Border Forecast section to understand how currency movements affect your consolidated net worth, and consider whether any FX hedging or diversification is appropriate.',
   'qualitative', null, 40, false, 'active'),

  ('general_income_concentration', 'Income concentrated in a single source', 'general',
   'A large majority of your income currently comes from a single employer or income source.',
   'Consider whether diversifying income sources (a second income stream, passive income) would reduce reliance on a single source.',
   'qualitative', null, 30, false, 'active')
on conflict (recommendation_code) do nothing;

-- Conditions: groups are AND'd, rows within the same group are OR'd.
insert into action_recommendation_conditions (recommendation_id, condition_group, field_path, operator, comparison_value)
select id, 1, 'dashboard.creditUtilization', 'gt', '0.3'::jsonb from action_recommendation_master where recommendation_code = 'debt_high_credit_utilization'
union all
select id, 1, 'variance.debt.status', 'in', '["at_risk", "significantly_off_track", "slightly_behind"]'::jsonb from action_recommendation_master where recommendation_code = 'debt_off_track_variance'
union all
select id, 1, 'dashboard.totalLiabilities', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'debt_extra_repayment_opportunity'
union all
select id, 2, 'dashboard.disposableIncome', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'debt_extra_repayment_opportunity'
union all
select id, 1, 'retirement.readinessPct', 'lt', '75'::jsonb from action_recommendation_master where recommendation_code = 'retirement_material_gap'
union all
select id, 1, 'retirement.depletionMonth', 'is_not_null', null from action_recommendation_master where recommendation_code = 'retirement_depletion_risk'
union all
select id, 1, 'dashboard.emergencyFundMonths', 'lt', '3'::jsonb from action_recommendation_master where recommendation_code = 'resilience_low_emergency_fund'
union all
select id, 1, 'resilience.depletionMonth', 'is_not_null', null from action_recommendation_master where recommendation_code = 'resilience_depletion_during_shock'
union all
select id, 1, 'dashboard.hasInsurance', 'eq', 'false'::jsonb from action_recommendation_master where recommendation_code = 'resilience_no_insurance_recorded'
union all
select id, 1, 'dashboard.monthlySurplus', 'lt', '0'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_negative_surplus'
union all
select id, 1, 'dashboard.savingsRate', 'lt', '0.1'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_low_savings_rate'
union all
select id, 1, 'dashboard.discretionaryRatio', 'gt', '0.5'::jsonb from action_recommendation_master where recommendation_code = 'cash_flow_high_discretionary'
union all
select id, 1, 'variance.net_worth.status', 'in', '["at_risk", "significantly_off_track"]'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_off_track'
union all
select id, 1, 'dashboard.liquidAssetRatio', 'lt', '0.05'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_low_liquidity'
union all
select id, 2, 'dashboard.totalAssets', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_low_liquidity'
union all
select id, 1, 'dashboard.propertyConcentration', 'gt', '0.7'::jsonb from action_recommendation_master where recommendation_code = 'net_worth_property_concentration'
union all
select id, 1, 'variance.goal.status', 'in', '["at_risk", "significantly_off_track", "slightly_behind"]'::jsonb from action_recommendation_master where recommendation_code = 'goal_off_track'
union all
select id, 1, 'dashboard.hasInvestments', 'eq', 'false'::jsonb from action_recommendation_master where recommendation_code = 'investment_start_investing_surplus'
union all
select id, 2, 'dashboard.monthlySurplus', 'gt', '0'::jsonb from action_recommendation_master where recommendation_code = 'investment_start_investing_surplus'
union all
select id, 1, 'dashboard.countriesInUseCount', 'gt', '1'::jsonb from action_recommendation_master where recommendation_code = 'cross_border_fx_exposure'
union all
select id, 1, 'dashboard.employerConcentration', 'gt', '0.7'::jsonb from action_recommendation_master where recommendation_code = 'general_income_concentration';
