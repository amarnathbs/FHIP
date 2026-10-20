-- 01 DIAGNOSE (READ ONLY): lists every row that decides how your SMSF is counted.
-- Run in the PRODUCTION Supabase SQL editor. It is ONE select statement: it cannot change anything.
-- Before running: replace PUT_YOUR_LOGIN_EMAIL_HERE (the only edit, keep the quotes) with the e-mail you log in with.
-- Expected for the PO household (AUD): the SMSF fund row 503,000 (owner self), Other Retirement Assets
-- 133,000 (owner smsf), no SMSF liability, personal liabilities 1,385,857, personal assets + investments 2,260,298.
--
-- Read the section column top to bottom. detail says how FHIP counts each row.
with u as (
  select id from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE')
),
ret as (select r.* from retirement_accounts r join u on r.user_id = u.id),
fund as (select f.* from smsf_funds f join u on f.user_id = u.id),
liab as (select l.* from liabilities l join u on l.user_id = u.id),
lnk as (select p.* from property_liability_links p join u on p.user_id = u.id where p.link_type = 'smsf_property_loan'),
ast as (select a.* from assets a join u on a.user_id = u.id),
inv as (select i.* from investments i join u on i.user_id = u.id),
ent as (select e.* from business_entities e join u on e.user_id = u.id),
out_rows as (
  select 10 as ord, 'retirement register (all rows)' as section, r.id::text as row_id, r.account_name::text as name,
         r.owner::text as owner, r.master_item_key::text as master_item_key, r.current_balance::numeric as amount,
         r.currency_code::text as currency, r.is_active as active,
         (case when r.master_item_key = 'smsf' then 'SMSF FUND ROW: managed in the SMSF section, its balance is the fund NET value'
               when r.owner = 'smsf' then 'owned by the SMSF: counted in the SMSF block of the family net worth'
               else 'personal' end)::text as detail
  from ret r
  union all
  select 20, 'smsf_funds', f.id::text, f.fund_name::text, null::text, null::text, coalesce(f.summary_balance, 0)::numeric,
         f.currency_code::text, f.is_active,
         ('mode=' || f.mode || ', summary_balance=' || coalesce(f.summary_balance::text, 'none') || ', detailed_net_value='
          || coalesce(f.detailed_net_value::text, 'none') || ', fund row=' || f.retirement_account_id::text)::text
  from fund f
  union all
  select 30, 'smsf_holdings', h.id::text, h.holding_name::text, null::text, h.holding_type::text, h.value::numeric,
         h.currency_code::text, h.is_active, ('fund ' || h.smsf_fund_id::text)::text
  from smsf_holdings h join fund f on f.id = h.smsf_fund_id
  union all
  select 40, 'liabilities register (all rows)', l.id::text, l.liability_name::text, l.owner::text, l.master_item_key::text,
         l.balance::numeric, l.currency_code::text, l.is_active,
         (case when exists (select 1 from lnk where lnk.liability_id = l.id and lnk.is_active) then 'LINKED to the SMSF as its property loan'
               when l.owner = 'smsf' then 'owned by the SMSF (owner tag)'
               else 'personal' end)::text
  from liab l
  union all
  select 50, 'assets / investments tagged to an entity', a.id::text, a.asset_name::text, a.owner::text, a.master_item_key::text,
         a.current_value::numeric, a.currency_code::text, a.is_active, 'assets register'::text
  from ast a where a.owner in ('smsf', 'family_trust', 'company')
  union all
  select 51, 'assets / investments tagged to an entity', i.id::text, i.investment_name::text, i.owner::text, i.master_item_key::text,
         i.current_value::numeric, i.currency_code::text, i.is_active, 'investments register'::text
  from inv i where i.owner in ('smsf', 'family_trust', 'company')
  union all
  select 60, 'registered entities (Companies and Trusts page)', e.id::text, e.name::text, e.entity_type::text, null::text,
         coalesce(e.summary_net_asset_value, 0)::numeric, e.currency_code::text, e.is_active,
         ('ownership ' || e.ownership_percentage::text || ' percent, valuation_mode=' || e.valuation_mode)::text
  from ent e
  union all
  -- Both representations at once: an entity that has a typed net value AND itemised lines.
  select 65, 'DATA QUALITY: entity with both a net value and itemised lines', e.id::text, e.name::text, e.entity_type::text, null::text,
         null::numeric, e.currency_code::text, e.is_active,
         ('mode=' || e.valuation_mode || ', net value=' || coalesce(e.summary_net_asset_value::text, 'none') || ', itemised assets='
          || (select count(*) from business_entity_assets x where x.business_entity_id = e.id)::text || ', itemised liabilities='
          || (select count(*) from business_entity_liabilities x where x.business_entity_id = e.id)::text)::text
  from ent e
  where e.summary_net_asset_value is not null
    and ((select count(*) from business_entity_assets x where x.business_entity_id = e.id)
       + (select count(*) from business_entity_liabilities x where x.business_entity_id = e.id)) > 0
  union all
  select 70, 'DATA QUALITY: SMSF recorded twice', null::text, 'fund row + SMSF-owned retirement rows both active'::text, null::text, null::text,
         (select coalesce(sum(r.current_balance), 0) from ret r where r.is_active and (r.master_item_key = 'smsf' or r.owner = 'smsf'))::numeric,
         null::text, true,
         ('fund row total ' || (select coalesce(sum(r.current_balance), 0) from ret r where r.is_active and r.master_item_key = 'smsf')::text
          || ' + SMSF-owned rows total ' || (select coalesce(sum(r.current_balance), 0) from ret r where r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf')::text
          || ' (flagged only when both are above zero)')::text
  where exists (select 1 from ret r where r.is_active and r.master_item_key = 'smsf' and r.current_balance > 0)
    and exists (select 1 from ret r where r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf' and r.current_balance > 0)
  union all
  select 80, 'TOTAL personal assets register + investments (active, not entity-tagged)', null::text, null::text, null::text, null::text,
         t.amount, t.currency, true, 'compare with your personal assets figure'::text
  from (select currency_code::text as currency, sum(v) as amount from (
          select currency_code, current_value as v from ast where is_active and owner not in ('smsf', 'family_trust', 'company')
          union all
          select currency_code, current_value from inv where is_active and owner not in ('smsf', 'family_trust', 'company')) s group by currency_code) t
  union all
  select 81, 'TOTAL personal liabilities (active, not SMSF-owned, not SMSF-linked)', null::text, null::text, null::text, null::text,
         t.amount, t.currency, true, 'compare with your personal liabilities figure'::text
  from (select currency_code::text as currency, sum(balance) as amount from liab
        where is_active and owner <> 'smsf' and id not in (select liability_id from lnk where is_active) group by currency_code) t
  union all
  select 82, 'TOTAL SMSF-related liabilities (owner smsf or linked)', null::text, null::text, null::text, null::text,
         t.amount, t.currency, true, 'the SMSF debt FHIP currently knows about'::text
  from (select currency_code::text as currency, sum(balance) as amount from liab
        where is_active and (owner = 'smsf' or id in (select liability_id from lnk where is_active)) group by currency_code) t
)
select section, row_id, name, owner, master_item_key, amount, currency, active, detail
from out_rows
order by ord, name;
