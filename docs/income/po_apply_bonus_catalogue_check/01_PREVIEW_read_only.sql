-- 01_PREVIEW_read_only.sql  (run FIRST, any environment: DEV vqycarelcoijzwlpkpcz or production)
-- READ ONLY. Changes nothing. Shows whether the Income catalogue offers Bonus / Commission / Overtime.
-- Expected on a healthy database: three rows, is_active = true, country_applicability = null (offered in AU and India).
select item_key, item_label, sort_order, is_active, country_applicability
from master_financial_items
where category = 'income' and item_key in ('employment_salary', 'bonus', 'commission', 'overtime')
order by sort_order;

-- Verdict (one row): 'OK - nothing to apply' or what is wrong.
select case
  when not exists (select 1 from master_financial_items where category = 'income' and item_key = 'bonus') then 'MISSING - run 02_APPLY_if_needed.sql'
  when exists (select 1 from master_financial_items where category = 'income' and item_key = 'bonus' and is_active is distinct from true) then 'INACTIVE - run 02_APPLY_if_needed.sql'
  when exists (select 1 from master_financial_items where category = 'income' and item_key = 'bonus' and country_applicability is not null) then 'COUNTRY-RESTRICTED - run 02_APPLY_if_needed.sql'
  else 'OK - nothing to apply'
end as bonus_catalogue_verdict;
