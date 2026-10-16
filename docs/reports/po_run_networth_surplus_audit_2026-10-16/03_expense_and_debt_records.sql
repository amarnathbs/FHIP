-- READ ONLY. Production. Lists every active expense and loan record behind the monthly outflow ($12,897 on the report). Changes nothing.
-- Run this one statement on its own. Output is masked: record id, name as shown on the screens, amounts only.
-- kind = expense or loan_repayment. monthly_aud is the monthly amount after frequency and currency conversion.
-- A loan_repayment row shows the repayment recorded on the Liabilities page; check the frequency assumption: the Liabilities
-- repayment field is a MONTHLY amount in the report, so a fortnightly or annual figure typed there would be overstated.
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
)
select * from (
  select
    'expense' as kind,
    e.id as record_id,
    e.expense_name as name,
    e.master_item_key,
    case when e.is_essential then 'essential' else 'discretionary' end as class,
    coalesce(e.owner, 'self') as owner,
    e.frequency,
    e.currency_code,
    e.amount as amount_per_period,
    round((case e.currency_code when 'AUD' then e.amount * m.mult when 'INR' then e.amount * m.mult / (select rate from fx) end)::numeric, 2) as monthly_aud,
    case when coalesce(e.owner, 'self') = 'smsf' or e.superseded_by_bank_import then 'no' else 'yes' end as counted_before_duplicate_rules
  from expense_items e
  join m on m.freq = e.frequency
  where e.user_id = (select id from u) and e.is_active
  union all
  select
    'loan_repayment',
    l.id,
    l.liability_name,
    l.master_item_key,
    l.debt_type,
    coalesce(l.owner, 'self'),
    'monthly',
    l.currency_code,
    l.monthly_repayment,
    round((case l.currency_code when 'AUD' then l.monthly_repayment when 'INR' then l.monthly_repayment / (select rate from fx) end)::numeric, 2),
    case when coalesce(l.owner, 'self') = 'smsf' then 'no' else 'yes' end
  from liabilities l
  where l.user_id = (select id from u) and l.is_active
) x
order by monthly_aud desc nulls last;
