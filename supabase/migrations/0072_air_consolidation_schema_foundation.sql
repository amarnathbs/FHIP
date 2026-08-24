-- Assets, Investments & Retirement Consolidation -- A2/A6 canonical data
-- model foundation. Pure additive DDL: new nullable columns and one new
-- table. No existing row is touched, no existing column is dropped or
-- renamed, no existing constraint is loosened. Safe on both a fresh
-- database and populated DEV.
--
-- NUMBERING NOTE: canonical origin/main (4b93682) ends at
-- 0071_fdh5_bank_pdf_engine_foundation.sql. A separate, still-in-progress
-- background workstream (Investment Intelligence R10 continuation) has
-- independently claimed 0070 on its own unmerged branch
-- (feature/investment-intelligence-r10-reports-premium) -- not yet on
-- main. 0072 is therefore the next genuinely free number as of 2026-08-24;
-- verified by listing supabase/migrations/ on a freshly fetched
-- origin/main AND by inspecting every open sibling branch's own migration
-- directory before allocating. If 0072 is independently claimed elsewhere
-- before this migration reaches DEV, this file renumbers -- per this
-- project's established collision precedent -- to the next free slot;
-- whichever migration is already live on DEV always keeps its number.
--
-- Context: see A0 discovery findings (reported alongside this migration).
-- The real defect this whole release addresses is NOT a UI dropdown
-- problem -- it is that supabase/seed_master_items.sql's
-- master_financial_items catalogue offers the same economic holding type
-- as a separately selectable, separately-summed row in more than one of
-- the assets / investments / retirement_accounts tables (e.g. 'Shares' in
-- Assets AND 'Australian Shares'/'International Shares' in Investments;
-- 'SMSF Balance' in Assets AND 'SMSF Investments' in Investments AND
-- 'SMSF' in Retirement; 'Industry Super'/'Retail Super'/'Defined Benefit'
-- in BOTH Assets and Retirement). Because assets/investments/
-- retirement_accounts are three physically separate tables, each summed
-- independently into totalAssets/totalInvestments/totalRetirement
-- (lib/engines/dashboard.ts's computeDashboard(), which already correctly
-- centralises Net Worth = totalAssets + totalInvestments + totalRetirement
-- - totalLiabilities -- CALC-04/CALC-05 architecture was already correct
-- going in), a user who ticks the same holding under two modules silently
-- double-counts it. This migration adds the metadata needed to describe
-- and govern that catalogue; 0073/0074 do the actual reclassification.

-- ---------------------------------------------------------------------------
-- 1. Canonical classification metadata on master_financial_items.
-- ---------------------------------------------------------------------------
-- item_key (already the stable code every calculation engine keys off --
-- see lib/engines/dashboard.ts's bucketAssetClass/bucketInvestmentType,
-- lib/engines/forecast/investmentCalculator.ts's MASTER_ITEM_TO_ASSET_CLASS
-- -- already satisfies spec's "use stable codes, not display labels"
-- requirement. No new identifier is introduced; these columns describe the
-- existing item_key rather than replacing it.
alter table master_financial_items
  -- Deterministic classification per spec section 52: whether a row tagged
  -- with this item currently contributes to Net Worth today (a balance),
  -- is a future cash-flow input to Forecasting only (a contribution), is
  -- an income/cash-flow source, or is a liability-side item. Exactly one
  -- is true for any active, in-scope item; both false means "not itself a
  -- monetary holding" (a purely structural/legacy row, none currently
  -- exist).
  add column if not exists is_current_value_source boolean not null default true,
  add column if not exists is_future_flow_source boolean not null default false,
  -- True for items that are legally/operationally retirement-specific
  -- (superannuation, pension, EPF/PPF/NPS, SMSF) -- lets UI and engines
  -- distinguish retirement holdings from general investments without
  -- re-deriving it from category text.
  add column if not exists is_retirement_specific boolean not null default false,
  -- True for items that are plausibly personal-use rather than held for
  -- investment growth (spec section 26: gold/silver/collectibles may be
  -- either -- this flag records the catalogue item's *default* purpose;
  -- it does not force a user's specific holding either way).
  add column if not exists is_personal_use_default boolean not null default false,
  -- When an item is retired from its current category in favour of a
  -- different canonical home, this records the destination so the
  -- migration trail is self-documenting in the schema itself (not just in
  -- migration-file prose). Null for items that were never relocated.
  add column if not exists superseded_by_category text,
  add column if not exists superseded_by_item_key text,
  -- Free-text canonical note shown to admins/support explaining *why* an
  -- item was deprecated or relabelled -- never shown to end users (the
  -- end-user-facing explanation, where one is needed, is written directly
  -- onto the affected user rows' own notes column in migration 0073).
  add column if not exists governance_note text;

comment on column master_financial_items.is_current_value_source is
  'True if a row tagged with this item counts toward the current Net Worth balance of its module today.';
comment on column master_financial_items.is_future_flow_source is
  'True if a row tagged with this item is a future contribution/cash-flow input to Forecasting, not a current balance (spec s.34-36).';
comment on column master_financial_items.is_retirement_specific is
  'True for superannuation/pension/EPF/PPF/NPS/SMSF-type items regardless of which category currently houses them.';
comment on column master_financial_items.is_personal_use_default is
  'True when this catalogue item is presumed personal-use by default (spec s.26) rather than investment-purpose.';
comment on column master_financial_items.superseded_by_category is
  'Set when this item was retired in favour of a canonical item in a different category (e.g. asset -> investment).';
comment on column master_financial_items.superseded_by_item_key is
  'The item_key in superseded_by_category that new entries of this economic holding type should use instead.';

-- ---------------------------------------------------------------------------
-- 2. Property <-> loan linkage (spec sections 21-23) -- mirrors the
--    already-existing, already-working goal_funding_sources /
--    user_goals.linked_liability_id pattern (migration 0009) rather than
--    inventing a new linkage mechanism. Nullable, additive, opt-in: no
--    existing row is required to set it, and net worth/liabilities are
--    already summed independently per spec section 74 (a linked property's
--    full market value and its loan's full balance both count separately
--    -- this column is purely a *relationship*, never a netting mechanism).
-- ---------------------------------------------------------------------------
alter table assets
  add column if not exists linked_liability_id uuid references liabilities(id) on delete set null;
alter table investments
  add column if not exists linked_liability_id uuid references liabilities(id) on delete set null;

comment on column assets.linked_liability_id is
  'Optional link from a property/home asset to its home loan / mortgage liability row (spec s.23). Purely relational -- both sides still sum independently into Net Worth (spec s.74).';
comment on column investments.linked_liability_id is
  'Optional link from an investment property to its investment-property-loan liability row (spec s.22). Purely relational -- both sides still sum independently into Net Worth (spec s.74).';

create index if not exists idx_assets_linked_liability on assets(linked_liability_id) where linked_liability_id is not null;
create index if not exists idx_investments_linked_liability on investments(linked_liability_id) where linked_liability_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Retirement member -- target retirement age captured once per member
--    (self/spouse), not once per account (spec section 30). Additive new
--    table; retirement_accounts.target_retirement_age (migration 0004)
--    is left in place unchanged for backward compatibility with any
--    existing per-account value already recorded -- nothing currently
--    reads retirement_members, so this is zero-risk to ship ahead of the
--    UI that will consume it.
-- ---------------------------------------------------------------------------
create table if not exists retirement_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  member_type text not null check (member_type in ('self', 'spouse')),
  target_retirement_age int check (target_retirement_age > 0 and target_retirement_age < 120),
  country_code char(2) references countries(country_code),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, member_type)
);

alter table retirement_members enable row level security;
create policy "own rows - retirement members" on retirement_members
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_retirement_members_user on retirement_members(user_id);

-- Optional link from a retirement_accounts row to the member it belongs
-- to -- additive, nullable; existing rows are unaffected and remain
-- attributed via the pre-existing 'owner' column (self/spouse/joint/...)
-- until a user explicitly sets up member-level records.
alter table retirement_accounts
  add column if not exists retirement_member_id uuid references retirement_members(id) on delete set null;
create index if not exists idx_retirement_accounts_member on retirement_accounts(retirement_member_id) where retirement_member_id is not null;
