-- READ ONLY. Production. Counts only: no names, no ids, no emails. Run on its own.
-- For income records written by a payslip apply: does the record frequency match the pay frequency of the payslip behind it?
-- A mismatch (for example a record kept as annually while the payslip is fortnightly) is the situation that put a one-fortnight
-- take-home beside an annual gross on the PO record. low_net_ratio counts those whose take-home is under 30% of gross.
select
  s.frequency as record_frequency,
  e.pay_frequency as payslip_pay_frequency,
  count(*) as records,
  count(distinct s.user_id) as households,
  count(*) filter (where s.net_amount is not null and s.amount > 0 and s.net_amount / s.amount < 0.30) as low_net_ratio,
  count(*) filter (where s.net_amount is null) as blank_take_home
from public.income_sources s
join public.fhip_import_applications a on a.id = s.last_import_application_id
join public.fdh_payroll_events e on e.id = a.source_payroll_event_id
where s.is_active and s.source_type = 'payslip_import'
group by 1, 2
order by records desc;
