-- READ ONLY. Production. Rebuilds the report cash-flow figures using the raw records. Changes nothing.
-- Run this one statement on its own. One output row; compare it with the report:
--   gross income 19,782 | net income 3,574 | essential 0 | discretionary 4,535 | debt repayments 8,362 | deficit -9,324
-- deductions_gross_less_net_known = gross income minus net income. When income_sources_with_blank_take_home is above 0,
-- most of that gap is NOT tax: it is income whose take-home pay was never entered, so it is left out of net income.
-- The expense and debt figures here are the plain register totals. The report additionally drops an expense row that
-- duplicates a loan repayment, and drops a card repayment when spending is counted, so small differences can be real.
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
),
m(freq, mult) as (
  values ('weekly', 52.0/12), ('fortnightly', 26.0/12), ('monthly', 1.0), ('quarterly', 1.0/3), ('annually', 1.0/12), ('one_off', 0.0)
),
inc as (
  select
    case i.currency_code when 'AUD' then i.amount * m.mult when 'INR' then i.amount * m.mult / (select rate from fx) end as gross_m,
    case i.currency_code when 'AUD' then i.net_amount * m.mult when 'INR' then i.net_amount * m.mult / (select rate from fx) end as net_m,
    (i.net_amount is null) as net_blank
  from income_sources i
  join m on m.freq = i.frequency
  where i.user_id = (select id from u) and i.is_active
    and coalesce(i.owner, 'self') <> 'smsf' and not coalesce(i.superseded_by_bank_import, false)
    and i.currency_code in ('AUD', 'INR')
),
exp as (
  select
    case e.currency_code when 'AUD' then e.amount * m.mult when 'INR' then e.amount * m.mult / (select rate from fx) end as monthly,
    e.is_essential
  from expense_items e
  join m on m.freq = e.frequency
  where e.user_id = (select id from u) and e.is_active
    and coalesce(e.owner, 'self') <> 'smsf' and not coalesce(e.superseded_by_bank_import, false)
    and e.currency_code in ('AUD', 'INR')
),
debt as (
  select
    case l.currency_code when 'AUD' then coalesce(l.monthly_repayment, 0) when 'INR' then coalesce(l.monthly_repayment, 0) / (select rate from fx) end as monthly
  from liabilities l
  where l.user_id = (select id from u) and l.is_active
    and coalesce(l.owner, 'self') <> 'smsf' and l.currency_code in ('AUD', 'INR')
)
select
  round((select coalesce(sum(gross_m), 0) from inc)) as gross_income,
  round((select coalesce(sum(net_m), 0) from inc)) as net_income_known_only,
  round((select coalesce(sum(gross_m), 0) from inc) - (select coalesce(sum(net_m), 0) from inc)) as deductions_gross_less_net_known,
  (select count(*) from inc) as income_sources_counted,
  (select count(*) from inc where net_blank) as income_sources_with_blank_take_home,
  round((select coalesce(sum(gross_m), 0) from inc where net_blank)) as gross_of_sources_with_blank_take_home,
  round((select coalesce(sum(monthly), 0) from exp where is_essential)) as essential_expenses,
  round((select coalesce(sum(monthly), 0) from exp where not is_essential)) as discretionary_expenses,
  round((select coalesce(sum(monthly), 0) from debt)) as debt_repayments_register_total,
  round((select coalesce(sum(net_m), 0) from inc) - (select coalesce(sum(monthly), 0) from exp) - (select coalesce(sum(monthly), 0) from debt)) as surplus_or_deficit_as_report_computes_it,
  round((select coalesce(sum(gross_m), 0) from inc) - (select coalesce(sum(monthly), 0) from exp) - (select coalesce(sum(monthly), 0) from debt)) as surplus_or_deficit_if_all_gross_were_take_home;
