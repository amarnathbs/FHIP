-- WRITES THE ESSENTIAL FLAG BACK TO OFF ON THE ROWS SAVED IN THE BACKUP. Production. STEP 5 of 5, ONLY IF you want it undone.
-- Normally you do not run this. It acts only on rows that are in the backup and are Essential now, and refreshes updated_at.
update public.expense_items e
set is_essential = false,
    updated_at = now()
from public.zz_backup_expense_essential_20261016 b
where e.id = b.id
  and e.is_essential
  and not b.is_essential
returning e.id, e.expense_name, e.master_item_key, e.is_essential;
