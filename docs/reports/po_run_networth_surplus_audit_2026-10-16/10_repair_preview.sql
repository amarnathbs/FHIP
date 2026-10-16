-- READ ONLY. Production. STEP 1 of 5 of the salary net-amount repair. Changes nothing. Run on its own.
-- Shows the one income record, which fields the last payslip apply wrote, and the payslip behind it.
-- Your facts: pay is fortnightly, 3,975.43 is the take-home of ONE payslip, gross is 196,994.48 a year (7,576.71 a fortnight).
-- repair_net_amount = 3,975.43 x 26 = 103,361.18, the take-home of a whole year on the same annual basis as the gross.
-- Why this repair and not re-expressing the record as fortnightly: it changes ONE value (net_amount) and leaves the gross, the
-- frequency and the provenance as they are. 7,576.71 x 26 = 196,994.46, two cents off your annual 196,994.48, so converting
-- the gross would alter a figure you typed for no benefit.
-- Every column starting with ok_ must say yes before you go on to step 2.
select
  s.id as record_id,
  s.source_name,
  s.source_type,
  s.frequency,
  s.currency_code,
  s.amount as gross_per_year,
  s.net_amount as net_now,
  round(s.amount / 26, 2) as gross_per_fortnight_if_26_pays,
  round(s.net_amount * 26, 2) as repair_net_amount,
  round(s.net_amount * 26 / 12, 2) as repair_net_per_month,
  round(s.net_amount / s.amount * 100, 1) as net_now_percent_of_gross,
  round(s.net_amount * 26 / s.amount * 100, 1) as repair_net_percent_of_gross,
  case when s.amount = 196994.48 and s.net_amount = 3975.43 and s.frequency = 'annually' then 'yes' else 'NO - values differ from the ones you gave me, stop' end as ok_values_match,
  to_char(s.updated_at, 'DD/MM/YYYY HH24:MI') as last_changed,
  a.apply_mode,
  a.applied_fields,
  a.previous_values,
  a.new_values,
  e.pay_frequency,
  e.pay_frequency_source,
  e.gross_pay as payslip_gross,
  e.net_pay as payslip_net,
  to_char(e.pay_period_start, 'DD/MM/YYYY') as pay_period_start,
  to_char(e.pay_period_end, 'DD/MM/YYYY') as pay_period_end,
  case when e.pay_frequency = 'fortnightly' and e.net_pay = s.net_amount then 'yes' else 'CHECK - payslip is not a fortnightly payslip with this net' end as ok_payslip_fortnightly_and_net_matches
from income_sources s
left join fhip_import_applications a on a.id = s.last_import_application_id
left join fdh_payroll_events e on e.id = a.source_payroll_event_id
where s.id = '63d26f07-a799-4286-bdb6-38f324c87428';
