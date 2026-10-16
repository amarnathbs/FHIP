-- 02_APPLY_if_needed.sql  (run ONLY if 01_PREVIEW_read_only.sql did not say 'OK - nothing to apply')
-- Idempotent and additive: it never renames or removes a catalogue item. Safe to run twice.
-- BACKUP FIRST (production has NO managed backups; this table is tiny):
create table if not exists _bak_master_financial_items_20261016 as select * from master_financial_items;

begin;
  -- 1. The row, if absent (same values as supabase/seed_master_items.sql).
  insert into master_financial_items (category, item_key, item_label, sort_order)
  values ('income', 'bonus', 'Bonus', 20)
  on conflict (category, item_key) do nothing;

  -- 2. If it exists but is switched off or restricted to one country, make it available to AU and India again.
  update master_financial_items
     set is_active = true, country_applicability = null
   where category = 'income' and item_key = 'bonus'
     and (is_active is distinct from true or country_applicability is not null);
commit;

-- Re-run 01_PREVIEW_read_only.sql: the verdict must now read 'OK - nothing to apply'.
-- Rollback if ever needed: restore the row from _bak_master_financial_items_20261016 (drop that table when you are done).
