-- Free/Paid Report v3, Phase 3a — starter pillar-triggered recommendation
-- rows. 2 per Health Score component (10 components x needs_attention +
-- excellent bands = 20 rows), using the trigger_type='score_pillar' /
-- pillar_code / score_band columns added in migration 0025. Deliberately
-- generic (no country_code) and with no deterministic $ impact calculator
-- (calculation_method_code='NO_CALCULATION', matching the existing
-- review_required-style rows imported for forecast-variance triggers) —
-- these are meant to bootstrap the Free/Paid report's action sections
-- (Phase 3a task #213), not to duplicate the country-specific forecast
-- library. include_in_forecasting=false / include_in_monthly_report=true
-- since these are report-only, the mirror image of the imported 542 rows.
insert into action_recommendation_master (
  recommendation_code, trigger_type, pillar_code, score_band,
  forecast_category, sub_category, scenario_name, scenario_description,
  variance_result, forecast_status, severity, action_type,
  action_title_template, action_content_template, financial_impact_template,
  calculation_method_code, required_input_fields, supported_placeholders,
  priority_score, country_code, currency_code, customer_segment,
  is_active, requires_ai, include_in_forecasting, include_in_monthly_report,
  admin_notes
) values
  ('PILLAR_CASH_FLOW_ATTENTION', 'score_pillar', 'cash_flow', 'needs_attention', null, 'pillar_score_band', 'Cash flow pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the cash_flow component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_cash_flow',
   $$Review your monthly cash flow$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Track income against expenses for a full month, and look for discretionary spending that can be trimmed to widen your monthly surplus.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_CASH_FLOW_MAINTAIN', 'score_pillar', 'cash_flow', 'excellent', null, 'pillar_score_band', 'Cash flow pillar is strong', 'Health Score pillar-triggered scenario. Applies when the cash_flow component''s status band is excellent.', 'favourable', null, 'low', 'maintain_cash_flow',
   $$Keep up your cash flow discipline$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep monitoring income and expenses regularly so this stays on track as circumstances change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_SAVINGS_ATTENTION', 'score_pillar', 'savings', 'needs_attention', null, 'pillar_score_band', 'Savings pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the savings component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_savings',
   $$Increase your savings rate$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Consider automating a fixed transfer to savings each pay cycle so a portion of income is set aside before it can be spent.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_SAVINGS_MAINTAIN', 'score_pillar', 'savings', 'excellent', null, 'pillar_score_band', 'Savings pillar is strong', 'Health Score pillar-triggered scenario. Applies when the savings component''s status band is excellent.', 'favourable', null, 'low', 'maintain_savings',
   $$Maintain your savings habit$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Continue the current savings routine and revisit the target amount as income or goals change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'score_pillar', 'emergency_fund', 'needs_attention', null, 'pillar_score_band', 'Emergency fund pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the emergency_fund component''s status band is needs_attention.', 'unfavourable', null, 'high', 'build_emergency_fund',
   $$Build up your emergency fund buffer$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Aim to hold accessible cash covering several months of essential expenses, building it up gradually if a lump sum isn't available now.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   80, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'score_pillar', 'emergency_fund', 'excellent', null, 'pillar_score_band', 'Emergency fund pillar is strong', 'Health Score pillar-triggered scenario. Applies when the emergency_fund component''s status band is excellent.', 'favourable', null, 'low', 'maintain_emergency_fund',
   $$Maintain your emergency fund$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep the buffer at its current level and review it after any major change in income or expenses.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_DEBT_ATTENTION', 'score_pillar', 'debt', 'needs_attention', null, 'pillar_score_band', 'Debt pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the debt component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_debt',
   $$Review your debt repayment plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review outstanding balances and interest rates, and consider directing extra surplus toward the highest-cost debt first.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_DEBT_MAINTAIN', 'score_pillar', 'debt', 'excellent', null, 'pillar_score_band', 'Debt pillar is strong', 'Health Score pillar-triggered scenario. Applies when the debt component''s status band is excellent.', 'favourable', null, 'low', 'maintain_debt',
   $$Keep your debt levels under control$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Continue keeping debt low relative to income and assets, and avoid taking on new high-cost borrowing.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_NET_WORTH_ATTENTION', 'score_pillar', 'net_worth', 'needs_attention', null, 'pillar_score_band', 'Net worth pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the net_worth component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_net_worth',
   $$Review your net worth trajectory$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review the balance between assets and liabilities and consider whether saving, debt reduction or asset growth would help most.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_NET_WORTH_MAINTAIN', 'score_pillar', 'net_worth', 'excellent', null, 'pillar_score_band', 'Net worth pillar is strong', 'Health Score pillar-triggered scenario. Applies when the net_worth component''s status band is excellent.', 'favourable', null, 'low', 'maintain_net_worth',
   $$Maintain your net worth growth$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep tracking assets and liabilities regularly so this position is maintained.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_INVESTMENT_ATTENTION', 'score_pillar', 'investment', 'needs_attention', null, 'pillar_score_band', 'Investment pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the investment component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_investment',
   $$Review your investment plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review contribution consistency and diversification across your recorded holdings.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_INVESTMENT_MAINTAIN', 'score_pillar', 'investment', 'excellent', null, 'pillar_score_band', 'Investment pillar is strong', 'Health Score pillar-triggered scenario. Applies when the investment component''s status band is excellent.', 'favourable', null, 'low', 'maintain_investment',
   $$Maintain your investment discipline$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep contributing consistently and review diversification periodically.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_RETIREMENT_ATTENTION', 'score_pillar', 'retirement', 'needs_attention', null, 'pillar_score_band', 'Retirement pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the retirement component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_retirement',
   $$Review your retirement savings plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review whether current retirement contributions are on track for your target retirement age and lifestyle.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_RETIREMENT_MAINTAIN', 'score_pillar', 'retirement', 'excellent', null, 'pillar_score_band', 'Retirement pillar is strong', 'Health Score pillar-triggered scenario. Applies when the retirement component''s status band is excellent.', 'favourable', null, 'low', 'maintain_retirement',
   $$Maintain your retirement savings trajectory$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep contributions consistent and revisit your retirement target periodically.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_INSURANCE_ATTENTION', 'score_pillar', 'insurance', 'needs_attention', null, 'pillar_score_band', 'Insurance pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the insurance component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_insurance',
   $$Review your insurance coverage$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review recorded cover against income, debt and dependants, and identify any obvious gaps to discuss with a qualified adviser.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_INSURANCE_MAINTAIN', 'score_pillar', 'insurance', 'excellent', null, 'pillar_score_band', 'Insurance pillar is strong', 'Health Score pillar-triggered scenario. Applies when the insurance component''s status band is excellent.', 'favourable', null, 'low', 'maintain_insurance',
   $$Keep your insurance coverage up to date$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Revisit cover after major life changes such as a new dependant, property purchase or income change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_RESILIENCE_ATTENTION', 'score_pillar', 'resilience', 'needs_attention', null, 'pillar_score_band', 'Resilience pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the resilience component''s status band is needs_attention.', 'unfavourable', null, 'high', 'review_resilience',
   $$Strengthen your financial resilience$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Visit the Financial Resilience page to see which underlying factor — liquidity, income stability, insurance or debt pressure — is weighing this down most.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   80, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_RESILIENCE_MAINTAIN', 'score_pillar', 'resilience', 'excellent', null, 'pillar_score_band', 'Resilience pillar is strong', 'Health Score pillar-triggered scenario. Applies when the resilience component''s status band is excellent.', 'favourable', null, 'low', 'maintain_resilience',
   $$Maintain your financial resilience$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep monitoring liquidity, income stability and insurance cover so this position holds up under stress.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_BEHAVIOUR_ATTENTION', 'score_pillar', 'behaviour', 'needs_attention', null, 'pillar_score_band', 'Behaviour pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the behaviour component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_behaviour',
   $$Build stronger financial habits$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Regular check-ins — paying bills on time, sticking to a budget, automating savings — are what this component measures; even one new habit can help.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   60, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_BEHAVIOUR_MAINTAIN', 'score_pillar', 'behaviour', 'excellent', null, 'pillar_score_band', 'Behaviour pillar is strong', 'Health Score pillar-triggered scenario. Applies when the behaviour component''s status band is excellent.', 'favourable', null, 'low', 'maintain_behaviour',
   $$Keep up your good financial habits$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep up the regular reviews and on-time payments that got you here.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.')
on conflict (recommendation_code) do nothing;

-- Conditions: every row above is gated purely on pillar_code + score_band
-- (an AND-chain, condition_group=1, mirroring the existing forecast_category
-- + forecast_status pattern used by every imported row).
insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator, comparison_value, data_type, logical_operator, evaluation_order)
select code, 1, 'pillar_code', 'equals', pillar, 'text', 'AND', 1
from (values
  ('PILLAR_CASH_FLOW_ATTENTION', 'cash_flow'), ('PILLAR_CASH_FLOW_MAINTAIN', 'cash_flow'),
  ('PILLAR_SAVINGS_ATTENTION', 'savings'), ('PILLAR_SAVINGS_MAINTAIN', 'savings'),
  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'emergency_fund'), ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'emergency_fund'),
  ('PILLAR_DEBT_ATTENTION', 'debt'), ('PILLAR_DEBT_MAINTAIN', 'debt'),
  ('PILLAR_NET_WORTH_ATTENTION', 'net_worth'), ('PILLAR_NET_WORTH_MAINTAIN', 'net_worth'),
  ('PILLAR_INVESTMENT_ATTENTION', 'investment'), ('PILLAR_INVESTMENT_MAINTAIN', 'investment'),
  ('PILLAR_RETIREMENT_ATTENTION', 'retirement'), ('PILLAR_RETIREMENT_MAINTAIN', 'retirement'),
  ('PILLAR_INSURANCE_ATTENTION', 'insurance'), ('PILLAR_INSURANCE_MAINTAIN', 'insurance'),
  ('PILLAR_RESILIENCE_ATTENTION', 'resilience'), ('PILLAR_RESILIENCE_MAINTAIN', 'resilience'),
  ('PILLAR_BEHAVIOUR_ATTENTION', 'behaviour'), ('PILLAR_BEHAVIOUR_MAINTAIN', 'behaviour')
) as t(code, pillar)
on conflict do nothing;

insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator, comparison_value, data_type, logical_operator, evaluation_order)
select code, 1, 'score_band', 'equals', band, 'text', 'AND', 2
from (values
  ('PILLAR_CASH_FLOW_ATTENTION', 'needs_attention'), ('PILLAR_CASH_FLOW_MAINTAIN', 'excellent'),
  ('PILLAR_SAVINGS_ATTENTION', 'needs_attention'), ('PILLAR_SAVINGS_MAINTAIN', 'excellent'),
  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'needs_attention'), ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'excellent'),
  ('PILLAR_DEBT_ATTENTION', 'needs_attention'), ('PILLAR_DEBT_MAINTAIN', 'excellent'),
  ('PILLAR_NET_WORTH_ATTENTION', 'needs_attention'), ('PILLAR_NET_WORTH_MAINTAIN', 'excellent'),
  ('PILLAR_INVESTMENT_ATTENTION', 'needs_attention'), ('PILLAR_INVESTMENT_MAINTAIN', 'excellent'),
  ('PILLAR_RETIREMENT_ATTENTION', 'needs_attention'), ('PILLAR_RETIREMENT_MAINTAIN', 'excellent'),
  ('PILLAR_INSURANCE_ATTENTION', 'needs_attention'), ('PILLAR_INSURANCE_MAINTAIN', 'excellent'),
  ('PILLAR_RESILIENCE_ATTENTION', 'needs_attention'), ('PILLAR_RESILIENCE_MAINTAIN', 'excellent'),
  ('PILLAR_BEHAVIOUR_ATTENTION', 'needs_attention'), ('PILLAR_BEHAVIOUR_MAINTAIN', 'excellent')
) as t(code, band)
on conflict do nothing;
