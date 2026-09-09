-- LR-11 — Company / Family Trust Entity Architecture (Company first; Family
-- Trust is an explicitly planned fast-follow reusing this same schema, per
-- the Product Owner's own phase-scoping decision).
--
-- DISCOVERY FINDING this migration responds to: `OWNER_VALUES` (lib/
-- constants.ts, migration 0004) already offers 'company'/'family_trust' as
-- values on the Owner dropdown of all 7 financial-data-grid registers
-- (income_sources, expense_items, assets, liabilities, investments,
-- retirement_accounts, insurance_policies) -- but this is, and remains, a
-- free-text label with ZERO backing entity, workspace or valuation logic.
-- This migration does NOT touch those tables, columns or their existing
-- Net Worth treatment (LR-FI-1 section 28's "wealth stays whole, always"
-- philosophy is certified, pre-existing behaviour and is out of this
-- migration's scope to reverse). It builds an entirely NEW, separate entity
-- registry instead -- see docs/live-recovery/LR11_PHASE_REPORT.md for the
-- disclosed double-entry risk this creates (a user could theoretically
-- record the same company's assets both as personal-grid rows tagged
-- owner='company' AND in this new workspace) and why that is a documented,
-- deferred UX concern rather than something this migration silently
-- "fixes" by touching certified LR-FI-1 code.
--
-- CONSOLIDATION MODEL (Product Owner decision, this phase): ownership % x
-- entity net asset value is the ONLY thing that ever reaches personal
-- household Net Worth (lib/engines/dashboard.ts, not touched by this
-- migration -- wired in the application layer). The entity's own
-- assets/liabilities line items live ONLY in the two child tables below and
-- are never separately summed into personal totalAssets/totalLiabilities --
-- elimination is structural (dedicated tables the personal engine never
-- reads), not a runtime filter, which is what WP-05's "never both without
-- elimination" lock requires.
--
-- LIABILITY SCOPE (Product Owner decision, this phase): entity liabilities
-- reduce the entity's own net asset value (and therefore flow into personal
-- Net Worth only via the ownership-% consolidation above) but never
-- separately enter personal DTI/DSR -- structurally guaranteed here too,
-- since business_entity_liabilities is never read by the personal
-- liabilities-based DTI/DSR formulas in dashboard.ts. This mirrors SMSF's
-- own treatment (liability reduces the entity's own net value; the
-- liability's cash-flow side, if any, never counts as personal debt
-- service) without copying SMSF's AU-only jurisdiction assumption -- see
-- the country_code column below.
--
-- WHY A NEW `business_entities` NAME, NOT `companies`: this phase's own
-- scoping decision explicitly plans Family Trust as a fast follow-up
-- "reusing almost everything" -- naming the table generically now (with
-- `entity_type` constrained to 'company' only for the moment) avoids a
-- table rename when Family Trust is added by a forward migration that
-- simply widens the entity_type CHECK constraint.
--
-- WHY NO DB-SIDE NAV-COMPUTE FUNCTION (unlike SMSF's
-- smsf_compute_detailed_net_value()): SMSF needed one because
-- retirement_accounts.current_balance has other historical writers and
-- needed an "exactly-one-active-valuation-source" trigger guard (migration
-- 0090) to prevent a multi-writer race. business_entities.summary_net_asset_
-- value / the two child tables are BRAND NEW, single-purpose tables with no
-- other writer to race against -- Detailed-mode net asset value is computed
-- read-time in the application layer (lib/services/businessEntityData.ts),
-- reusing the exact same reportingValue()/convertToReportingCurrency()
-- currency-conversion helpers dashboard.ts already trusts, rather than
-- duplicating that logic in a second, DB-side fx implementation.
--
-- WHY country_code IS NULLABLE, UNLIKE SMSF's hardcoded AU gate
-- (retirement_accounts_smsf_au_gate() trigger, migration 0084 above in this
-- same file): SMSF is a specific AU legal structure; "Company"/"Family
-- Trust" are generic ownership labels with no obvious single-country
-- restriction, and this phase's own discovery explicitly warns against
-- copying SMSF's AU-only assumption onto Company/Trust without evidence
-- (WP-09). NULL means "no jurisdiction restriction" -- global by default.

create table if not exists business_entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Constrained to 'company' only for this phase -- Family Trust is a
  -- planned forward migration widening this CHECK, not a design unknown.
  entity_type text not null default 'company' check (entity_type in ('company')),
  name text not null,
  -- NULL = no jurisdiction restriction (global). Do not default this to
  -- 'AU' -- see header note on why SMSF's AU-only assumption does not
  -- transfer here.
  country_code char(2) references countries(country_code),
  currency_code char(3) not null default 'AUD' references currencies(currency_code),
  -- The user's own declared ownership share of this entity (0, 100]. This
  -- phase's consolidation model is single-owner-percentage, not a
  -- multi-member cap table (Product Owner decision) -- if the same entity
  -- has co-owners outside this household, only this user's own percentage
  -- of the entity's net asset value is ever consolidated into THEIR
  -- personal Net Worth.
  ownership_percentage numeric(5, 2) not null default 100.00 check (ownership_percentage > 0 and ownership_percentage <= 100),
  valuation_mode text not null default 'summary' check (valuation_mode in ('summary', 'detailed')),
  -- Net-entity-value (assets minus liabilities), NOT gross-asset-value --
  -- same semantics as smsf_funds.summary_balance. Only meaningful when
  -- valuation_mode = 'summary'; ignored (but not cleared) when 'detailed'.
  summary_net_asset_value numeric(18, 2),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column business_entities.summary_net_asset_value is
  'Net entity value (assets minus liabilities), NOT gross-asset-value -- matches the net lump-sum semantics smsf_funds.summary_balance already established. Consolidated into personal household Net Worth as (ownership_percentage / 100) * this value, or the Detailed-mode equivalent computed from business_entity_assets/business_entity_liabilities -- never both at once (application-layer choice keyed off valuation_mode, mirroring SMSF''s own summary-XOR-detailed discipline).';

comment on column business_entities.ownership_percentage is
  'This user''s own declared ownership share (0, 100] of the entity''s net asset value. Single-owner-percentage model (Product Owner decision, LR-11) -- not a multi-member cap table. The ONLY figure of this entity that reaches personal household Net Worth is ownership_percentage/100 * net asset value; the entity''s own underlying assets/liabilities are never separately counted in personal totalAssets/totalLiabilities.';

create index if not exists idx_business_entities_user on business_entities(user_id);

create table if not exists business_entity_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_entity_id uuid not null references business_entities(id) on delete cascade,
  label text not null,
  value numeric(18, 2) not null check (value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_business_entity_assets_entity on business_entity_assets(business_entity_id);
create index if not exists idx_business_entity_assets_user on business_entity_assets(user_id);

create table if not exists business_entity_liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_entity_id uuid not null references business_entities(id) on delete cascade,
  label text not null,
  value numeric(18, 2) not null check (value >= 0),
  currency_code char(3) not null references currencies(currency_code),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table business_entity_liabilities is
  'LR-11: entity-owned liabilities. Deliberately NEVER read by the personal liabilities-based DTI/DSR formulas in lib/engines/dashboard.ts (Product Owner decision: entity debt is excluded from personal DTI/DSR, mirroring SMSF''s own treatment) -- the exclusion is structural (a table the personal engine never queries), not a runtime filter on a shared table.';

create index if not exists idx_business_entity_liabilities_entity on business_entity_liabilities(business_entity_id);
create index if not exists idx_business_entity_liabilities_user on business_entity_liabilities(user_id);

-- RLS -- exact pattern reused from smsf_funds/smsf_fund_members/smsf_holdings
-- above in this same migration file (owner-only on the parent, cross-
-- referenced subquery on every child so an authenticated attacker cannot
-- attach a row to another tenant's entity by guessing its UUID).

alter table business_entities enable row level security;
alter table business_entity_assets enable row level security;
alter table business_entity_liabilities enable row level security;

create policy "own rows - business entities" on business_entities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own rows - business entity assets" on business_entity_assets
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id and business_entity_id in (select id from business_entities where user_id = auth.uid()));

create policy "own rows - business entity liabilities" on business_entity_liabilities
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id and business_entity_id in (select id from business_entities where user_id = auth.uid()));

-- ROLLBACK: `drop table business_entity_assets; drop table
-- business_entity_liabilities; drop table business_entities;`. Safe at any
-- point -- no other table has a foreign key into any of these three, and
-- nothing outside this new schema reads them yet (application-layer wiring
-- is a separate, later commit).
