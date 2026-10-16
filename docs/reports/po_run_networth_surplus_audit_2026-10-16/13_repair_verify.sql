-- READ ONLY. Production. STEP 4 of 5. Run on its own after step 3.
-- Checks the record now reads net 103,361.18 a year (8,613.43 a month), and rebuilds the household net income using all four
-- income records. Expected net_income_monthly about 11,856 (8,613.43 + 2,015.00 + 1,208.33 + 19.10) and
-- surplus_or_deficit about -1,041 once the report is regenerated (expenses 4,535 plus loan repayments 8,362).
select
  (select net_amount from public.income_sources where id = '63d26f07-a799-4286-bdb6-38f324c87428') as salary_net_per_year,
  (select round(net_amount / 12, 2) from public.income_sources where id = '63d26f07-a799-4286-bdb6-38f324c87428') as salary_net_per_month,
  round(sum(case s.frequency when 'weekly' then 52.0 / 12 when 'fortnightly' then 26.0 / 12 when 'monthly' then 1 when 'quarterly' then 1.0 / 3 when 'annually' then 1.0 / 12 else 0 end * coalesce(s.net_amount, s.amount))) as net_income_monthly,
  round(sum(case s.frequency when 'weekly' then 52.0 / 12 when 'fortnightly' then 26.0 / 12 when 'monthly' then 1 when 'quarterly' then 1.0 / 3 when 'annually' then 1.0 / 12 else 0 end * s.amount)) as gross_income_monthly,
  round(sum(case s.frequency when 'weekly' then 52.0 / 12 when 'fortnightly' then 26.0 / 12 when 'monthly' then 1 when 'quarterly' then 1.0 / 3 when 'annually' then 1.0 / 12 else 0 end * coalesce(s.net_amount, s.amount)) - 4535 - 8362) as surplus_or_deficit_with_register_expenses_and_debt
from public.income_sources s
where s.user_id = (select user_id from public.income_sources where id = '63d26f07-a799-4286-bdb6-38f324c87428')
  and s.is_active and coalesce(s.owner, 'self') <> 'smsf' and not coalesce(s.superseded_by_bank_import, false) and s.currency_code = 'AUD';
