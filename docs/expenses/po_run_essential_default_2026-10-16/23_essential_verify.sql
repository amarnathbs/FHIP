-- READ ONLY. Production. STEP 4 of 5. Run on its own after step 3, then regenerate the report.
-- rows_in_backup = rows step 2 saved; rows_now_essential = how many of them are Essential now (should be equal unless you edited some).
-- essential_monthly_aud and discretionary_monthly_aud rebuild the Essential / Discretionary tiles of the report for your account.
-- emergency_fund_months = cash and deposits in the assets register divided by essential_monthly_aud (the report may also count
-- offset accounts and term deposits as cash, so the report figure is the one to read).
with u as (
  select id from auth.users where email = 'amarnath.bekal@gmail.com'
),
fx as (
  select coalesce(
    (select assumption_value::numeric from forecast_global_assumptions
      where assumption_key = 'fx_rate_aud_inr' and is_active and country_code is null limit 1),
    56) as rate
),
m as (
  select e.is_essential,
    case e.currency_code when 'AUD' then e.amount when 'INR' then e.amount / (select rate from fx) end
      * case e.frequency when 'weekly' then 52.0 / 12 when 'fortnightly' then 26.0 / 12 when 'monthly' then 1 when 'quarterly' then 1.0 / 3 when 'annually' then 1.0 / 12 else 0 end as monthly
  from public.expense_items e
  where e.user_id = (select id from u) and e.is_active and coalesce(e.owner, 'self') <> 'smsf' and not coalesce(e.superseded_by_bank_import, false)
)
select
  (select count(*) from public.zz_backup_expense_essential_20261016) as rows_in_backup,
  (select count(*) from public.expense_items e join public.zz_backup_expense_essential_20261016 b on b.id = e.id where e.is_essential) as rows_now_essential,
  round((select coalesce(sum(monthly), 0) from m where is_essential)::numeric, 2) as essential_monthly_aud,
  round((select coalesce(sum(monthly), 0) from m where not is_essential)::numeric, 2) as discretionary_monthly_aud,
  round(((select coalesce(sum(a.current_value), 0) from public.assets a where a.user_id = (select id from u) and a.is_active and a.master_item_key in ('wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency') and a.currency_code = 'AUD')
    / nullif((select sum(monthly) from m where is_essential), 0))::numeric, 2) as emergency_fund_months;
