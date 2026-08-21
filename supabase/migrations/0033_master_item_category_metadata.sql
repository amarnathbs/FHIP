-- Chunk 3a item 1 (Spec 1 §9 / Spec 2 §44-46): stable-identity inspection +
-- category metadata columns on master_financial_items.
--
-- IDENTITY INSPECTION (Spec 2 §44's explicit "inspect first" instruction):
-- master_financial_items.item_key is already a stable, unique-per-category
-- code for a CATALOGUE ENTRY (unique(category, item_key), migration
-- 0004_financial_data_grid.sql:11) that is never reused/renamed once live
-- (see seed_master_items.sql's own header discipline and 0031's deprecate-
-- not-rename precedent). Separately, every user-owned register (assets,
-- investments, retirement_accounts, ...) already has its own immutable
-- `id uuid primary key default gen_random_uuid()` identifying one specific
-- user's holding row, which several other tables already reference (e.g.
-- financial_records_audit.entity_id). The combination of a user row's own
-- `id` (durable holding identity) plus its `master_item_key` (durable
-- catalogue-type identity) already satisfies "stable financial-holding
-- identity that survives edits" — nothing about editing a row's value,
-- owner, currency, purchase details, etc. ever changes its `id`.
-- CONCLUSION: a new `financial_holding_id` abstraction is NOT built by this
-- migration. It would be a pure synonym for the existing `id` column with
-- no new capability, which Spec 2 §44 explicitly warns against building
-- "merely for architectural elegance." The one scenario where a synthetic
-- cross-table identity might eventually matter is 3b's future catalogue
-- consolidation (e.g. a row moving from `assets` to `investments` would get
-- a new `id` in the destination table) — that is 3b's concern to assess
-- when it actually designs the consolidation/migration mechanics, not
-- something to pre-build speculatively here. See
-- docs/app-review-2026-08/CHUNK3A_CANONICAL_SCHEMA.md for the full writeup.
--
-- CATEGORY METADATA (Spec 1 §9 / Spec 2 §46): additive columns describing
-- each catalogue item's own conditional-field and classification behaviour,
-- so the grid can stop uniformly showing/requiring purchase_date/
-- purchase_price for every asset type (Spec 1 §9's defect) regardless of
-- whether that concept even applies (a bank balance has no "purchase
-- price"). Nullable/defaulted so every pre-existing row (and every category
-- this migration doesn't populate — income/expense/liability/insurance)
-- keeps working exactly as before until explicitly populated by the next
-- migration (0034). No existing row's data is touched by adding these
-- columns; no existing application code reads them yet either (wired in the
-- same commit, guarded to fall back to today's always-shown/never-required
-- behaviour when a value is null — see lib/grid/fieldVisibility.ts).

alter table master_financial_items
  add column if not exists requires_purchase_date boolean not null default false,
  add column if not exists supports_purchase_date boolean not null default false,
  add column if not exists requires_purchase_price boolean not null default false,
  add column if not exists supports_purchase_price boolean not null default false,
  add column if not exists requires_country boolean not null default true,
  add column if not exists requires_currency boolean not null default true,
  add column if not exists supports_income_link boolean not null default false,
  add column if not exists supports_liability_link boolean not null default false,
  add column if not exists current_value_source text
    check (current_value_source is null or current_value_source in ('balance', 'market_value', 'calculated')),
  -- true = this catalogue item represents a contribution/flow into another
  -- holding (e.g. an employer super contribution), not a current-value
  -- holding in its own right — see Spec 2 §52 and the retirement
  -- account-vs-contribution separation in migration 0036.
  add column if not exists future_flow_source boolean not null default false,
  -- Nullable on purpose: only populated where the same real-world category
  -- genuinely needs a personal-vs-investment-purpose distinction (gold,
  -- silver, collectibles, certain property types per Spec 2 §26 and the
  -- discovery doc's Assets §217/236 notes) — left null everywhere the
  -- distinction doesn't apply (e.g. a savings account, a car loan).
  add column if not exists purpose_dimension text
    check (purpose_dimension is null or purpose_dimension in ('personal', 'investment'));

comment on column master_financial_items.requires_purchase_date is
  'Chunk 3a: hard-require a purchase_date for this catalogue item on save. Currently false for every row — see 0034''s population notes on why nothing is hard-required yet.';
comment on column master_financial_items.supports_purchase_date is
  'Chunk 3a: whether a purchase_date field is meaningful for this catalogue item at all (false = grid hides the field unless a value was already saved).';
comment on column master_financial_items.requires_purchase_price is
  'Chunk 3a: hard-require a purchase_price for this catalogue item on save. Currently false for every row.';
comment on column master_financial_items.supports_purchase_price is
  'Chunk 3a: whether a purchase_price field is meaningful for this catalogue item at all.';
comment on column master_financial_items.current_value_source is
  'Chunk 3a (Spec 2 §52): balance | market_value | calculated | null (null = future_flow_source items, which have no current value at all).';
comment on column master_financial_items.future_flow_source is
  'Chunk 3a (Spec 2 §34-36/§52): true = this item is a contribution/flow input, not a current-value holding.';
comment on column master_financial_items.purpose_dimension is
  'Chunk 3a (Spec 2 §26): personal | investment | null. Null = the distinction genuinely does not apply or cannot be inferred from the catalogue alone.';
