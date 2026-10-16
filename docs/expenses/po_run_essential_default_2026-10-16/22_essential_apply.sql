-- WRITES THE ESSENTIAL FLAG ON THE ROWS SAVED IN THE BACKUP ONLY. Production. STEP 3 of 5. Run only after step 2 succeeded.
-- Sets is_essential = true and refreshes updated_at (so the Monthly Report rebuilds). Nothing else is changed.
-- A row is changed only if it is in the backup AND still has Essential off AND has not been edited since the backup was taken,
-- so running it twice, or after you changed a row yourself, changes nothing for that row. Rows you ticked or edited are left alone.
update public.expense_items e
set is_essential = true,
    updated_at = now()
from public.zz_backup_expense_essential_20261016 b
where e.id = b.id
  and not e.is_essential
  and e.updated_at = b.updated_at
returning e.id, e.expense_name, e.master_item_key, e.is_essential;
