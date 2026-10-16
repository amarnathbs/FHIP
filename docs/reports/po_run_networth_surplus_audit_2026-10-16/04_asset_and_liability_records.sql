-- READ ONLY. Production. Lists every active asset, investment, retirement and liability record behind Net Worth. Changes nothing.
-- Run this one statement on its own. Output is masked: record id, name as shown on the screens, value, register, group.
-- register = the table the record lives in. This is what the Net worth box uses:
--   assets register = "Property, cash & other" | investments register = "Investments" | retirement = "Retirement".
-- wealth_chart_group = the group the "Where your wealth is held" chart puts the same record in (same mapping as the app).
-- A property recorded in the investments register counts under Investments in the Net worth box but under Property in the chart.
-- If one real property appears once in assets AND once in investments, that is a double count: look for matching names or values.
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
)
select * from (
  select
    'assets' as register,
    a.id as record_id,
    a.asset_name as name,
    a.master_item_key,
    a.asset_class as type_field,
    coalesce(a.owner, 'self') as owner,
    a.source_type,
    a.country_code,
    a.currency_code,
    a.current_value as value_native,
    round((case a.currency_code when 'AUD' then a.current_value when 'INR' then a.current_value / (select rate from fx) end)::numeric, 2) as value_aud,
    case
      when a.master_item_key in ('wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency') then 'cash'
      when a.master_item_key in ('principal_residence', 'investment_property', 'holiday_home', 'vacant_land', 'commercial_property', 'farm') then 'property'
      when a.master_item_key in ('business_ownership', 'partnership_interest') then 'business'
      when a.master_item_key in ('gold', 'silver') then 'gold'
      when a.master_item_key = 'cryptocurrency' then 'crypto'
      when a.master_item_key in ('shares', 'etfs', 'managed_funds') then 'shares'
      when a.master_item_key = 'bonds' then 'fixed_income'
      when a.asset_class = 'cash' then 'cash'
      when a.asset_class = 'property' then 'property'
      when a.asset_class = 'business' then 'business'
      else 'other' end as wealth_chart_group
  from assets a
  where a.user_id = (select id from u) and a.is_active
  union all
  select
    'investments',
    v.id,
    v.investment_name,
    v.master_item_key,
    v.investment_type,
    coalesce(v.owner, 'self'),
    v.source_type,
    v.country_code,
    v.currency_code,
    v.current_value,
    round((case v.currency_code when 'AUD' then v.current_value when 'INR' then v.current_value / (select rate from fx) end)::numeric, 2),
    case
      when v.master_item_key in ('cash_investments', 'high_interest_savings', 'term_deposits') then 'cash'
      when v.master_item_key in ('property', 'commercial_property', 'reits') then 'property'
      when v.master_item_key in ('bonds', 'government_bonds', 'corporate_bonds') then 'fixed_income'
      when v.master_item_key in ('gold', 'silver') then 'gold'
      when v.master_item_key = 'cryptocurrency' then 'crypto'
      when v.master_item_key in ('business_investment', 'partnership_investment') then 'business'
      when v.master_item_key in ('shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares') then 'shares'
      when v.investment_type in ('cash_investments', 'high_interest_savings', 'term_deposits') then 'cash'
      when v.investment_type in ('property', 'commercial_property', 'reits') then 'property'
      when v.investment_type in ('bonds', 'government_bonds', 'corporate_bonds') then 'fixed_income'
      when v.investment_type in ('gold', 'silver') then 'gold'
      when v.investment_type = 'cryptocurrency' then 'crypto'
      when v.investment_type in ('business_investment', 'partnership_investment') then 'business'
      when v.investment_type in ('shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares') then 'shares'
      else 'other' end
  from investments v
  where v.user_id = (select id from u) and v.is_active
  union all
  select
    'retirement',
    t.id,
    t.account_name,
    null,
    t.account_type,
    coalesce(t.owner, 'self'),
    t.source_type,
    t.country_code,
    t.currency_code,
    t.current_balance,
    round((case t.currency_code when 'AUD' then t.current_balance when 'INR' then t.current_balance / (select rate from fx) end)::numeric, 2),
    'super'
  from retirement_accounts t
  where t.user_id = (select id from u) and t.is_active
  union all
  select
    'liabilities',
    l.id,
    l.liability_name,
    l.master_item_key,
    l.debt_type,
    coalesce(l.owner, 'self'),
    l.source_type,
    l.country_code,
    l.currency_code,
    l.balance,
    round((case l.currency_code when 'AUD' then l.balance when 'INR' then l.balance / (select rate from fx) end)::numeric, 2),
    'liability'
  from liabilities l
  where l.user_id = (select id from u) and l.is_active
) x
order by register, value_aud desc nulls last;
