-- A2. THE SHAPES THE CUTOVER AND THE NEW RULES CARE ABOUT (READ ONLY, information only). One select. Keep the output.
-- How many households have an SMSF, an entity that holds both a typed net and lines, and personal rows tagged SMSF.
select 'SMSF funds (active)' as what, count(*)::text as n from smsf_funds where is_active
union all select 'itemised SMSF funds that still carry a typed net', count(*)::text from smsf_funds where is_active and mode = 'detailed' and summary_balance is not null
union all select 'business entities (active)', count(*)::text from business_entities where is_active
union all select 'itemised entities that also carry a typed net', count(*)::text from business_entities where is_active and valuation_mode = 'detailed' and summary_net_asset_value is not null
union all select 'personal liabilities tagged SMSF (active)', count(*)::text from liabilities where is_active and owner = 'smsf'
union all select 'personal income tagged SMSF (active)', count(*)::text from income_sources where is_active and owner = 'smsf'
union all select 'personal expenses tagged SMSF (active)', count(*)::text from expense_items where is_active and owner = 'smsf'
union all select 'retirement rows tagged SMSF other than the fund row (active)', count(*)::text from retirement_accounts where is_active and owner = 'smsf' and coalesce(master_item_key, '') <> 'smsf'
union all select 'households that already ticked no retirement savings', count(*)::text from user_profiles where not_applicable_retirement is true
union all select 'of those, how many ALSO hold an active retirement account or SMSF (the guard never rejects these, it only blocks new ticks)', count(*)::text
  from user_profiles p
  where p.not_applicable_retirement is true
    and (exists (select 1 from retirement_accounts r where r.user_id = p.user_id and r.is_active is not false and r.master_item_key is distinct from 'smsf')
         or exists (select 1 from smsf_funds f where f.user_id = p.user_id and f.is_active is not false));
