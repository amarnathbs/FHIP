-- WRITES ONE NEW TABLE (a copy of the rows step 1 marked would_change = yes). Production. STEP 2 of 5.
-- Production has no managed backups, so this is the backup. It stops with an error if the backup already exists.
-- Run only after you have read step 1. It does not touch expense_items. Keep the table until you have checked the report.
create table public.zz_backup_expense_essential_20261016 as
select e.*
from public.expense_items e
where e.user_id = (select id from auth.users where email = 'amarnath.bekal@gmail.com')
  and e.is_active
  and coalesce(e.owner, 'self') <> 'smsf'
  and not e.is_essential
  and e.source_type = 'manual'
  and e.updated_at <= e.created_at + interval '10 seconds'
  and e.master_item_key in ('rent', 'mortgage', 'council_rates', 'water_rates', 'water', 'electricity', 'gas', 'groceries', 'health_insurance', 'medical', 'pharmacy', 'fuel', 'public_transport', 'home_insurance', 'body_corporate', 'internet');
