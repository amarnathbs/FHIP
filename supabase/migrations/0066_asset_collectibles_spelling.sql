-- AR-0 §3.6 / Chunk 1 item 5: fixes the 'collectables'/'collectibles'
-- spelling inconsistency within the 'asset' catalogue category only.
-- ('investment' category already spells this item_key 'collectibles' —
-- see supabase/seed_master_items.sql line ~192 — so 'collectibles' is the
-- canonical spelling this migration standardises 'asset' on. This migration
-- does NOT touch the separate asset<->investment cross-category conceptual
-- duplication flagged in the discovery doc's §3.6 Class-C list — that
-- consolidation is explicitly out of scope for this chunk and belongs to
-- the later taxonomy-consolidation phase.)
--
-- Per seed_master_items.sql's own header discipline ("item_key is stable
-- and referenced by user rows; only add/deprecate (is_active), never
-- rename"): additive only. The misspelled 'collectables' row is deprecated
-- (is_active = false), not deleted or renamed in place, and a new
-- correctly-spelled 'collectibles' row is added as active. No existing
-- `assets` row is touched — any row with master_item_key = 'collectables'
-- keeps that value untouched by this migration.
--
-- IMPORTANT — disclosed risk, not yet resolved by this migration: a
-- read-only DEV check (vqycarelcoijzwlpkpcz) confirmed 2 real user rows in
-- `assets` currently have master_item_key = 'collectables'. FinancialDataGrid.tsx's
-- row-merge logic (components/grid/FinancialDataGrid.tsx's `load()`) only
-- ever renders a saved row if its master_item_key matches a *currently
-- active* master_financial_items row, or falls back to a "custom row" only
-- when master_item_key IS NULL. A saved row whose master_item_key points at
-- a now-deprecated item key matches neither path, so once this migration
-- is applied those 2 users' "Collectables" asset rows would stop appearing
-- in their Assets grid (the DB row itself is untouched and their totals are
-- unaffected, since dashboard.ts sums by current_value regardless of
-- catalogue is_active). This is a pre-existing FinancialDataGrid.tsx gap,
-- not introduced by this migration, but this migration is the first thing
-- that would surface it. Do not apply this migration to DEV/production
-- until either (a) FinancialDataGrid.tsx is given a fallback path for
-- orphaned master_item_key values, or (b) the Product Owner explicitly
-- accepts the 2 known affected users' rows going temporarily invisible in
-- the grid pending a data-fix prompt.

update master_financial_items
set is_active = false
where category = 'asset' and item_key = 'collectables';

insert into master_financial_items (category, item_key, item_label, sort_order, is_active)
values ('asset', 'collectibles', 'Collectibles', 310, true)
on conflict (category, item_key) do nothing;
