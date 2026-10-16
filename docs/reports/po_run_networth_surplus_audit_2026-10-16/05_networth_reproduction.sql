-- READ ONLY. Production. Rebuilds the report Net Worth figures using the raw records. Changes nothing.
-- Run this one statement on its own. One output row; compare it with the report:
--   assets register (Property, cash & other) 1,670,298 | investments 590,000 | retirement 636,000 | total assets 2,896,298
--   liabilities 1,385,857 | net worth 1,510,441.
-- Wealth chart groups on the report: property 1,960,000 | cash 21,798 | shares 25,000 | super 636,000 | other 253,500.
-- investments_in_property_group is the part of the investments register that the chart shows as Property (this is the gap
-- between Property, cash and other 1,670,298 and the chart groups). Amounts in a currency other than AUD or INR are excluded
-- by the app and are counted in unconverted_rows here so the exclusion is visible.
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
),
a as (
  select
    case x.currency_code when 'AUD' then x.current_value when 'INR' then x.current_value / (select rate from fx) end as v,
    case
      when x.master_item_key in ('wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency') then 'cash'
      when x.master_item_key in ('principal_residence', 'investment_property', 'holiday_home', 'vacant_land', 'commercial_property', 'farm') then 'property'
      when x.master_item_key in ('business_ownership', 'partnership_interest') then 'business'
      when x.master_item_key in ('gold', 'silver') then 'gold'
      when x.master_item_key = 'cryptocurrency' then 'crypto'
      when x.master_item_key in ('shares', 'etfs', 'managed_funds') then 'shares'
      when x.master_item_key = 'bonds' then 'fixed_income'
      when x.asset_class = 'cash' then 'cash'
      when x.asset_class = 'property' then 'property'
      when x.asset_class = 'business' then 'business'
      else 'other' end as grp
  from assets x where x.user_id = (select id from u) and x.is_active
),
v as (
  select
    case x.currency_code when 'AUD' then x.current_value when 'INR' then x.current_value / (select rate from fx) end as v,
    case
      when x.master_item_key in ('cash_investments', 'high_interest_savings', 'term_deposits') then 'cash'
      when x.master_item_key in ('property', 'commercial_property', 'reits') then 'property'
      when x.master_item_key in ('bonds', 'government_bonds', 'corporate_bonds') then 'fixed_income'
      when x.master_item_key in ('gold', 'silver') then 'gold'
      when x.master_item_key = 'cryptocurrency' then 'crypto'
      when x.master_item_key in ('business_investment', 'partnership_investment') then 'business'
      when x.master_item_key in ('shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares') then 'shares'
      when x.investment_type in ('cash_investments', 'high_interest_savings', 'term_deposits') then 'cash'
      when x.investment_type in ('property', 'commercial_property', 'reits') then 'property'
      when x.investment_type in ('bonds', 'government_bonds', 'corporate_bonds') then 'fixed_income'
      when x.investment_type in ('gold', 'silver') then 'gold'
      when x.investment_type = 'cryptocurrency' then 'crypto'
      when x.investment_type in ('business_investment', 'partnership_investment') then 'business'
      when x.investment_type in ('shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares') then 'shares'
      else 'other' end as grp
  from investments x where x.user_id = (select id from u) and x.is_active
),
t as (
  select case x.currency_code when 'AUD' then x.current_balance when 'INR' then x.current_balance / (select rate from fx) end as v
  from retirement_accounts x where x.user_id = (select id from u) and x.is_active
),
l as (
  select case x.currency_code when 'AUD' then x.balance when 'INR' then x.balance / (select rate from fx) end as v
  from liabilities x where x.user_id = (select id from u) and x.is_active
)
select
  (select rate from fx) as fx_inr_per_aud_used,
  round((select coalesce(sum(v), 0) from a)) as assets_register_property_cash_other,
  round((select coalesce(sum(v), 0) from v)) as investments_register,
  round((select coalesce(sum(v), 0) from t)) as retirement,
  round((select coalesce(sum(v), 0) from a) + (select coalesce(sum(v), 0) from v) + (select coalesce(sum(v), 0) from t)) as total_assets,
  round((select coalesce(sum(v), 0) from l)) as total_liabilities,
  round((select coalesce(sum(v), 0) from a) + (select coalesce(sum(v), 0) from v) + (select coalesce(sum(v), 0) from t) - (select coalesce(sum(v), 0) from l)) as net_worth,
  round((select coalesce(sum(v), 0) from a where grp = 'property') + (select coalesce(sum(v), 0) from v where grp = 'property')) as chart_property,
  round((select coalesce(sum(v), 0) from v where grp = 'property')) as investments_in_property_group,
  round((select coalesce(sum(v), 0) from a where grp = 'cash') + (select coalesce(sum(v), 0) from v where grp = 'cash')) as chart_cash,
  round((select coalesce(sum(v), 0) from a where grp = 'shares') + (select coalesce(sum(v), 0) from v where grp = 'shares')) as chart_shares,
  round((select coalesce(sum(v), 0) from a where grp = 'other') + (select coalesce(sum(v), 0) from v where grp = 'other')) as chart_other,
  (select count(*) from a where v is null) + (select count(*) from v where v is null) + (select count(*) from t where v is null) + (select count(*) from l where v is null) as unconverted_rows;
