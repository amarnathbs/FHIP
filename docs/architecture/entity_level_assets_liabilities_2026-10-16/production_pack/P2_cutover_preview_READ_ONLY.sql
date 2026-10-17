-- P2 CUTOVER PREVIEW (READ ONLY, one select). Shows exactly what P3 will do, before it does anything.
-- Edit the three values in the first line of the query (the e-mail you log in with, the SMSF loan amount, the loan name).
-- The loan amount is the PO decision of 17-10-2026: 370000. The older inactive personal row says 365000, which is stale and is NOT used.
-- Reading the result, top to bottom:
--   TO BE RETIRED   the leftover typed net value and the duplicate Retirement row(s) owned by the SMSF (archived, never deleted, kept in the history).
--   LEFT ALONE      inactive rows that stay inactive (the old personal loan row, the old Trust Assets row).
--   TO BE ADDED     the SMSF loan, as a liability of the fund.
--   RESULT          assets minus the loan is the fund net. With 370000: 503000 - 370000 = 133000.
with params as (
  select 'PUT_YOUR_LOGIN_EMAIL_HERE'::text as email, 370000::numeric as loan_amount, 'SMSF property loan'::text as loan_name
),
u as (select au.id from auth.users au join params p on lower(au.email) = lower(p.email)),
fund as (select f.* from smsf_funds f join u on f.user_id = u.id where f.is_active),
hold as (select h.* from smsf_holdings h join fund f on f.id = h.smsf_fund_id where h.is_active),
dup as (select r.* from retirement_accounts r join u on r.user_id = u.id
        where r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf'),
old_loans as (select l.* from liabilities l join u on l.user_id = u.id
              where not l.is_active and (l.owner = 'smsf' or position('smsf' in lower(l.liability_name)) > 0)),
old_assets as (select a.* from assets a join u on a.user_id = u.id where not a.is_active and a.owner = 'smsf'),
rows_out as (
  select 10 as ord, 'FUND' as section, f.fund_name::text as name, f.mode::text as detail, f.detailed_net_value::numeric as amount from fund f
  union all
  select 20, 'ASSETS OF THE FUND (kept)', h.holding_name::text, h.holding_type::text, h.value::numeric from hold h
  union all
  select 30, 'TO BE RETIRED: leftover typed net value', f.fund_name::text, 'stays in the history'::text, f.summary_balance::numeric
    from fund f where f.summary_balance is not null
  union all
  select 31, 'TO BE RETIRED: duplicate Retirement row owned by the SMSF', d.account_name::text, 'archived, not deleted'::text, d.current_balance::numeric from dup d
  union all
  select 40, 'LEFT ALONE: inactive personal loan row', l.liability_name::text, ('stays inactive, owner ' || l.owner)::text, l.balance::numeric from old_loans l
  union all
  select 41, 'LEFT ALONE: inactive SMSF-owned asset row', a.asset_name::text, 'stays inactive'::text, a.current_value::numeric from old_assets a
  union all
  select 50, 'TO BE ADDED: liability of the fund', p.loan_name::text, 'property loan'::text, p.loan_amount from params p
  union all
  select 60, 'RESULT: assets of the fund', null::text, null::text, (select coalesce(sum(value), 0) from hold)
  union all
  select 61, 'RESULT: liabilities of the fund', null::text, null::text, (select loan_amount from params)
  union all
  select 62, 'RESULT: net of the fund (assets minus liabilities)', null::text, null::text, (select coalesce(sum(value), 0) from hold) - (select loan_amount from params)
)
select section, name, detail, amount from rows_out order by ord, name;
