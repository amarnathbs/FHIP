-- P4 VERIFY (READ ONLY, one select). Run after P3. Replace PUT_YOUR_LOGIN_EMAIL_HERE (the only edit, keep the quotes).
-- Expected for the PO household with the loan at 370000:
--   fund mode detailed, typed net empty, assets 503000, liabilities 370000, derived net 133000, the Retirement row for the fund 133000,
--   no active duplicate Retirement row owned by the SMSF, no row in the data quality list, and two history rows (retire typed net, archive rows).
-- Then on the Dashboard: personal net worth 874441 (unchanged) and family net worth 1007441.
with u as (select id from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE')),
fund as (select f.* from smsf_funds f join u on f.user_id = u.id where f.is_active),
rows_out as (
  select 10 as ord, 'fund mode' as check_name, f.mode::text as value from fund f
  union all select 20, 'typed net value (should be empty)', coalesce(f.summary_balance::text, 'empty') from fund f
  union all select 30, 'assets of the fund', (select coalesce(sum(h.value), 0) from smsf_holdings h where h.smsf_fund_id = f.id and h.is_active)::text from fund f
  union all select 40, 'liabilities of the fund', (select coalesce(sum(l.balance), 0) from smsf_liabilities l where l.smsf_fund_id = f.id and l.is_active)::text from fund f
  union all select 50, 'derived net of the fund', f.detailed_net_value::text from fund f
  union all select 60, 'Retirement row for the fund', (select ra.current_balance from retirement_accounts ra where ra.id = f.retirement_account_id)::text from fund f
  union all select 70, 'active duplicate Retirement rows owned by the SMSF (should be 0)',
    (select count(*) from retirement_accounts r join u on r.user_id = u.id where r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf')::text from fund f
  union all select 80, 'data quality: funds holding both a typed net and itemised lines (should be 0)',
    (select count(*) from smsf_funds s join u on s.user_id = u.id where s.is_active and ((s.mode = 'detailed' and s.summary_balance is not null)
      or (s.mode = 'summary' and (exists (select 1 from smsf_holdings h where h.smsf_fund_id = s.id and h.is_active) or exists (select 1 from smsf_liabilities l where l.smsf_fund_id = s.id and l.is_active)))))::text from fund f
  union all select 90, 'history rows written (expect 2 after P3)',
    (select count(*) from entity_figure_mode_log g join u on g.user_id = u.id where g.entity_id = f.id)::text from fund f
)
select check_name, value from rows_out order by ord;
