-- READ ONLY. Production. Counts only: no names, no ids, no emails. Run on its own.
-- How many wage income records (employment salary, bonus, commission, overtime, or anything applied by a payslip) have a
-- take-home that is implausible against the gross on the same record, and how many have no take-home at all.
-- ratio_band: under_10 and from_10_to_30 are the suspect bands (tax alone cannot explain a take-home under 30% of gross);
-- over_100 means take-home is above gross; blank_take_home records are now calculated at their gross (PO decision 16-10-2026).
select
  case
    when s.net_amount is null then 'blank_take_home'
    when s.amount <= 0 then 'zero_gross'
    when s.net_amount / s.amount > 1.0001 then 'over_100'
    when s.net_amount / s.amount < 0.10 then 'under_10'
    when s.net_amount / s.amount < 0.30 then 'from_10_to_30'
    else 'plausible_30_or_more'
  end as ratio_band,
  count(*) as records,
  count(distinct s.user_id) as households,
  count(*) filter (where s.source_type = 'payslip_import') as of_which_payslip_import,
  count(*) filter (where s.frequency = 'annually') as of_which_annually,
  count(*) filter (where s.frequency = 'fortnightly') as of_which_fortnightly,
  count(*) filter (where s.frequency = 'monthly') as of_which_monthly
from public.income_sources s
where s.is_active
  and coalesce(s.owner, 'self') <> 'smsf'
  and (s.source_type = 'payslip_import' or s.master_item_key in ('employment_salary', 'bonus', 'commission', 'overtime'))
group by 1
order by 1;
