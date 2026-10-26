-- WP-C read-only checks. Safe to run any time, on DEV first. It changes nothing.
-- It works before and after migrations 0295 to 0297 (it only uses columns that already exist).
-- Read the result: every row is a check name, what it counted, and the number.

select 'smsf funds (active)' as check_name, 'how many SMSF funds exist' as detail, count(*)::text as n
from smsf_funds where is_active
union all
select 'smsf itemised fund still holds a typed net', 'itemised funds carrying an old typed net value, shown to the user as a note', count(*)::text
from smsf_funds where is_active and mode = 'detailed' and summary_balance is not null
union all
select 'smsf liabilities (fund own debts)', 'active rows in smsf_liabilities', count(*)::text
from smsf_liabilities where is_active
union all
select 'personal liabilities tagged SMSF', 'earlier way, to be moved with the SMSF screen', count(*)::text
from liabilities where is_active and owner = 'smsf'
union all
select 'personal income tagged SMSF', 'earlier way, moved with the Move button on the SMSF screen', count(*)::text
from income_sources where is_active and owner = 'smsf'
union all
select 'personal expenses tagged SMSF', 'earlier way, moved with the Move button on the SMSF screen', count(*)::text
from expense_items where is_active and owner = 'smsf'
union all
select 'smsf property assets still tied to a personal income record', 'rent recorded the earlier way', count(*)::text
from smsf_holdings where is_active and linked_income_source_id is not null
union all
select 'business entities (active)', entity_type, count(*)::text
from business_entities where is_active group by entity_type
union all
select 'entity holds BOTH a typed net and itemised lines', 'either-or rule: the user is asked which to keep', count(*)::text
from business_entities e
where e.is_active and e.valuation_mode = 'detailed' and e.summary_net_asset_value is not null
union all
select 'entity net value only but has lines', 'either-or rule: the lines are not counted', count(*)::text
from business_entities e
where e.is_active and e.valuation_mode = 'summary'
  and (exists (select 1 from business_entity_assets a where a.business_entity_id = e.id)
       or exists (select 1 from business_entity_liabilities l where l.business_entity_id = e.id))
order by 1, 2;
