-- Module 10 (Forecasting Engine) — seed data for forecast_global_assumptions.
-- Starting defaults only, administered/updatable later via an admin page
-- (not built in Phase 1). Values are broad, defensible planning
-- assumptions, not statutory rates — per the spec, nothing here is
-- hardcoded into application code, only referenced by key at read time.

insert into forecast_global_assumptions (country_code, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference) values
  -- General inflation and growth assumptions — Australia
  ('AU', 'general', 'general_inflation', 2.5, 'percentage', 'per_annum', 'RBA inflation target band midpoint'),
  ('AU', 'general', 'education_inflation', 4.0, 'percentage', 'per_annum', 'Historical education cost growth, indicative'),
  ('AU', 'general', 'healthcare_inflation', 4.5, 'percentage', 'per_annum', 'Historical healthcare cost growth, indicative'),
  ('AU', 'general', 'property_growth', 4.0, 'percentage', 'per_annum', 'Long-run indicative residential property growth'),
  ('AU', 'general', 'salary_growth', 3.0, 'percentage', 'per_annum', 'Long-run indicative wage growth'),
  ('AU', 'general', 'rental_income_growth', 3.0, 'percentage', 'per_annum', 'Indicative, tracks general inflation'),
  ('AU', 'general', 'general_expense_growth', 2.5, 'percentage', 'per_annum', 'Tracks general inflation assumption'),
  ('AU', 'general', 'savings_rate_assumption', 15.0, 'percentage', 'of_net_income', 'Indicative planning reference, not a target'),
  ('AU', 'general', 'investment_contribution_growth', 2.5, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('AU', 'general', 'retirement_contribution_growth', 2.5, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('AU', 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  ('AU', 'general', 'retirement_age', 67, 'number', 'years', 'Australian Age Pension qualifying age reference'),
  ('AU', 'general', 'life_expectancy', 87, 'number', 'years', 'ABS indicative life expectancy reference'),
  ('AU', 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  -- Investment return assumptions by asset class — Australia
  ('AU', 'investment_return', 'cash', 3.5, 'percentage', 'per_annum', 'Indicative cash/term-deposit return'),
  ('AU', 'investment_return', 'fixed_interest', 4.0, 'percentage', 'per_annum', 'Indicative bond/fixed-interest return'),
  ('AU', 'investment_return', 'equity', 7.5, 'percentage', 'per_annum', 'Indicative long-run equity return'),
  ('AU', 'investment_return', 'property', 5.0, 'percentage', 'per_annum', 'Indicative long-run property total return'),
  ('AU', 'investment_return', 'superannuation', 6.5, 'percentage', 'per_annum', 'Indicative balanced-option long-run return'),
  ('AU', 'investment_return', 'other_asset', 5.0, 'percentage', 'per_annum', 'Generic fallback for unclassified asset types'),

  -- General inflation and growth assumptions — India
  ('IN', 'general', 'general_inflation', 5.0, 'percentage', 'per_annum', 'RBI inflation target band midpoint'),
  ('IN', 'general', 'education_inflation', 8.0, 'percentage', 'per_annum', 'Historical India education cost growth, indicative'),
  ('IN', 'general', 'healthcare_inflation', 8.0, 'percentage', 'per_annum', 'Historical India healthcare cost growth, indicative'),
  ('IN', 'general', 'property_growth', 6.0, 'percentage', 'per_annum', 'Long-run indicative Indian residential property growth'),
  ('IN', 'general', 'salary_growth', 7.0, 'percentage', 'per_annum', 'Long-run indicative Indian wage growth'),
  ('IN', 'general', 'rental_income_growth', 5.0, 'percentage', 'per_annum', 'Indicative, tracks general inflation'),
  ('IN', 'general', 'general_expense_growth', 5.0, 'percentage', 'per_annum', 'Tracks general inflation assumption'),
  ('IN', 'general', 'savings_rate_assumption', 20.0, 'percentage', 'of_net_income', 'Indicative planning reference, not a target'),
  ('IN', 'general', 'investment_contribution_growth', 5.0, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('IN', 'general', 'retirement_contribution_growth', 5.0, 'percentage', 'per_annum', 'Tracks salary growth assumption'),
  ('IN', 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  ('IN', 'general', 'retirement_age', 60, 'number', 'years', 'Common Indian retirement age reference'),
  ('IN', 'general', 'life_expectancy', 75, 'number', 'years', 'Indicative Indian life expectancy reference'),
  ('IN', 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  -- Investment return assumptions by asset class — India
  ('IN', 'investment_return', 'cash', 6.5, 'percentage', 'per_annum', 'Indicative FD/savings return'),
  ('IN', 'investment_return', 'fixed_interest', 7.0, 'percentage', 'per_annum', 'Indicative bond/debt-fund return'),
  ('IN', 'investment_return', 'equity', 11.0, 'percentage', 'per_annum', 'Indicative long-run Indian equity return'),
  ('IN', 'investment_return', 'property', 7.0, 'percentage', 'per_annum', 'Indicative long-run Indian property total return'),
  ('IN', 'investment_return', 'retirement', 8.0, 'percentage', 'per_annum', 'Indicative EPF/PPF/NPS blended long-run return'),
  ('IN', 'investment_return', 'other_asset', 6.0, 'percentage', 'per_annum', 'Generic fallback for unclassified asset types'),

  -- Country-neutral defaults (used when country_code is null / unmatched)
  (null, 'general', 'general_inflation', 3.0, 'percentage', 'per_annum', 'Global fallback default'),
  (null, 'general', 'emergency_fund_target_months', 6.0, 'number', 'months', 'FHIP planning reference'),
  (null, 'general', 'withdrawal_rate', 4.0, 'percentage', 'per_annum', 'Common indicative safe-withdrawal-rate reference'),
  (null, 'investment_return', 'other_asset', 5.0, 'percentage', 'per_annum', 'Global fallback default')
on conflict (country_code, assumption_key) do nothing;
