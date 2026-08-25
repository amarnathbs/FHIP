-- Property <-> Liability Linking -- canonical, allocation-aware relationship
-- between property holdings (Assets/Investments, with schema headroom for a
-- future SMSF property row in Retirement) and the liabilities that finance
-- them. Pure additive DDL + one new table + two new catalogue items +
-- conservative deterministic-only backfill. No existing column is dropped,
-- renamed or narrowed; no existing row's balance/value is touched.
--
-- NUMBERING NOTE: canonical origin/main (81712a3) ends at
-- 0077_retirement_member_target_age.sql; `node scripts/check-migration-
-- versions.mjs` and `--against=origin/main` both confirmed 0078 as the next
-- free slot with zero cross-branch collisions at the time this file was
-- written. Two other background workstreams (FDH-8 Expense Tracker,
-- Investment Intelligence R11) are independently active against this same
-- migration directory -- both checks were re-run immediately before this
-- migration was finalised (see the closure report) and, per this project's
-- own collision precedent, this file renumbers to the next free slot if a
-- collision is discovered before reaching DEV; whichever migration is
-- already live on DEV always keeps its number.
--
-- Context: see PL-0 discovery findings (reported alongside this migration).
-- Two real pre-existing architectural facts shaped this design:
--   1. Migration 0072 already added a single nullable `linked_liability_id`
--      column to `assets` and `investments` (one-to-one only, schema-ready
--      but never wired into any API route or UI -- confirmed by a full-repo
--      grep turning up nothing but its own schema-contract test). It cannot
--      represent multiple facilities (spec s.5-6, e.g. a mortgage split into
--      Split A + Split B) or cross-collateralisation (one loan financing two
--      properties), both explicitly required. It is left in place, untouched
--      and unused (no destructive change), and is marked superseded via a
--      column comment below so its status is documented in the schema
--      itself, not just here.
--   2. `assets`/`liabilities` still enforce `unique(user_id, master_item_key)`
--      (migration 0004; NOT dropped for `liabilities`, unlike `investments`
--      which had its equivalent constraint dropped in 0042) and
--      lib/services/registry.ts's save() upserts on that same key for any
--      catalogue-linked row. A user therefore already models "Split A + Split
--      B" the same way the rest of the grid models any same-type multiple
--      today: one catalogue row (e.g. Home Loan) plus one or more
--      "+ Add Custom Item" rows (master_item_key = null, unconstrained). This
--      migration's relationship table is keyed on liability `id`, not
--      master_item_key, so it is fully compatible with that existing pattern
--      without requiring any change to it.
--
-- Idempotent: every DDL statement uses IF NOT EXISTS / OR REPLACE; the
-- catalogue inserts use ON CONFLICT DO NOTHING; the backfill INSERT..SELECT
-- statements are naturally idempotent (NOT EXISTS guards against re-creating
-- a link that already exists, active or not).

begin;

-- ---------------------------------------------------------------------------
-- 0. Document the superseded 0072 columns (spec s.6: reuse where safe, but
--    don't force a strictly-one-to-one column to carry a many-to-many
--    relationship). Comment-only; the columns themselves are untouched.
-- ---------------------------------------------------------------------------
comment on column assets.linked_liability_id is
  'Superseded by property_liability_links (migration 0078), which supports multiple facilities and cross-collateralisation. Left in place, unused, for backward compatibility -- never populated by this or any later migration.';
comment on column investments.linked_liability_id is
  'Superseded by property_liability_links (migration 0078), which supports multiple facilities and cross-collateralisation. Left in place, unused, for backward compatibility -- never populated by this or any later migration.';

-- ---------------------------------------------------------------------------
-- 1. Two genuinely missing liability catalogue items (spec s.13: "inspect
--    actual current catalogue codes ... do not introduce duplicate catalogue
--    items merely to support linking"). The existing catalogue has no
--    dedicated Commercial Property Loan or SMSF Property Loan/LRBA item --
--    'investment_loan' is the closest existing item but does not distinguish
--    residential from commercial, and no SMSF-debt item exists at all. Both
--    are genuinely new economic holding types, not duplicates of anything
--    already seeded. ON CONFLICT DO NOTHING keys off the pre-existing
--    unique(category, item_key) constraint (migration 0004), so this is safe
--    to re-run and safe even if a concurrent branch seeded the same keys.
-- ---------------------------------------------------------------------------
insert into master_financial_items (category, item_key, item_label, sort_order) values
  ('liability', 'commercial_loan', 'Commercial Property Loan', 145),
  ('liability', 'smsf_property_loan', 'SMSF Property Loan / LRBA', 205)
on conflict (category, item_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. property_liability_links -- the canonical relationship (spec s.6-10).
--    Follows the same established pattern as goal_funding_sources (migration
--    0009): one nullable FK per possible "holding side" table rather than a
--    single polymorphic (table_name, row_id) pair, so real foreign-key
--    integrity is enforced by Postgres rather than only by application code.
--    `linked_retirement_id` is included now, unused, purely as schema
--    headroom (spec s.36: "design the relationship model so SMSF property
--    can later link to SMSF debt without a redesign") -- retirement_accounts
--    has no discrete SMSF-property holding row today (only a lump-sum 'smsf'
--    balance item), so nothing in this release ever inserts a non-null value
--    there; the SMSF property UI itself stays explicitly out of scope
--    (spec s.36, s.84).
-- ---------------------------------------------------------------------------
create table if not exists property_liability_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Property side -- exactly one of these three is set (enforced below).
  linked_asset_id uuid references assets(id) on delete cascade,
  linked_investment_id uuid references investments(id) on delete cascade,
  linked_retirement_id uuid references retirement_accounts(id) on delete cascade,

  -- Debt side -- the liability keeps its own canonical balance; this table
  -- never stores or derives a second balance (spec s.3, s.65).
  liability_id uuid not null references liabilities(id) on delete cascade,

  -- Canonical stable codes (spec s.7) -- never a display string.
  link_type text not null check (link_type in (
    'owner_occupied_mortgage',
    'investment_property_loan',
    'commercial_property_loan',
    'smsf_property_loan',
    'property_secured_other',
    'cross_collateralised'
  )),

  -- Analytical attribution only (spec s.8-10) -- never changes
  -- liabilities.balance or assets/investments.current_value. Defaults to
  -- 100 for the common single-property-per-loan case; cross-collateralised
  -- loans set an explicit lower value per property, enforced (across the
  -- whole liability, not just one row) by the trigger below.
  allocation_percent numeric(5,2) not null default 100
    check (allocation_percent > 0 and allocation_percent <= 100),
  allocation_amount numeric(18,2) check (allocation_amount >= 0),

  is_primary boolean not null default true,

  -- Provenance (spec s.6, s.37-43): 'manual' = created via the Property or
  -- Liability UI; 'backfill_deterministic' = this migration's own
  -- conservative auto-link. 'confidence' records the match strength that
  -- produced it -- only 'deterministic' matches are ever auto-linked
  -- (spec s.40); 'probable'/'ambiguous'/'no_match' candidates from the PL-0
  -- audit are never written as rows at all, by design (nothing to flag
  -- against, since no relationship exists yet).
  source text not null default 'manual' check (source in ('manual', 'backfill_deterministic')),
  confidence text check (confidence in ('deterministic', 'probable', 'user_confirmed')),

  notes text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- Exactly one property-side FK -- prevents a row that links nothing, and
  -- prevents a single row from ambiguously claiming two different holdings.
  constraint chk_pll_property_side_exactly_one check (
    (case when linked_asset_id is not null then 1 else 0 end +
     case when linked_investment_id is not null then 1 else 0 end +
     case when linked_retirement_id is not null then 1 else 0 end) = 1
  )
);

comment on table property_liability_links is
  'Canonical, many-to-many-capable relationship between a property holding (asset/investment, or in future an SMSF property) and the liability that finances it. Purely relational: never alters either side''s stored balance/value (spec s.3, s.8-10).';
comment on column property_liability_links.allocation_percent is
  'Analytical attribution of a cross-collateralised loan across its financed properties. NEVER used to scale liabilities.balance -- the liability''s own balance is always the full canonical amount (spec s.10).';

-- No duplicate identical active link between the same property and the same
-- liability (spec s.52). Three partial unique indexes, one per property-side
-- column, since exactly one is ever non-null per row.
create unique index if not exists uq_pll_asset_liability_active
  on property_liability_links(linked_asset_id, liability_id)
  where is_active and linked_asset_id is not null;
create unique index if not exists uq_pll_investment_liability_active
  on property_liability_links(linked_investment_id, liability_id)
  where is_active and linked_investment_id is not null;
create unique index if not exists uq_pll_retirement_liability_active
  on property_liability_links(linked_retirement_id, liability_id)
  where is_active and linked_retirement_id is not null;

create index if not exists idx_pll_user on property_liability_links(user_id);
create index if not exists idx_pll_liability on property_liability_links(liability_id) where is_active;
create index if not exists idx_pll_asset on property_liability_links(linked_asset_id) where is_active and linked_asset_id is not null;
create index if not exists idx_pll_investment on property_liability_links(linked_investment_id) where is_active and linked_investment_id is not null;
create index if not exists idx_pll_retirement on property_liability_links(linked_retirement_id) where is_active and linked_retirement_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Total active allocation for one liability must never exceed 100%
--    (spec s.9-10) -- a cross-row aggregate constraint, so it needs a
--    trigger rather than a plain CHECK. Fires on INSERT and on UPDATE of
--    the columns that can change the sum (allocation_percent, is_active,
--    liability_id).
-- ---------------------------------------------------------------------------
create or replace function pll_enforce_allocation_cap() returns trigger as $$
declare
  total numeric(6,2);
begin
  if new.is_active then
    select coalesce(sum(allocation_percent), 0) into total
    from property_liability_links
    where liability_id = new.liability_id
      and is_active
      and id <> new.id;
    total := total + new.allocation_percent;
    if total > 100 then
      raise exception 'property_liability_links: total active allocation for liability % would be %%%, exceeding 100%%', new.liability_id, total
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pll_allocation_cap on property_liability_links;
create trigger trg_pll_allocation_cap
  before insert or update of allocation_percent, is_active, liability_id on property_liability_links
  for each row execute function pll_enforce_allocation_cap();

-- ---------------------------------------------------------------------------
-- 4. Server-side relationship-type validation (spec s.27-31, s.52-55) --
--    a defence-in-depth backstop behind the application-layer check in
--    lib/services/propertyLiabilityLinksData.ts. Consumer debt must never
--    gain investment-debt treatment merely because a user links it, even if
--    a future code path forgets the application-layer guard. Custom
--    liabilities (master_item_key is null -- e.g. a second mortgage split
--    added via "+ Add Custom Item") are NOT in the catalogue at all, so
--    they cannot be checked against it; they are deliberately allowed
--    through here (this is the only way the existing multi-facility-loan
--    pattern described in the header note above can be linked at all) and
--    rely on the UI only ever offering linking from a property/liability
--    context in the first place plus this same explicit consumer denylist.
-- ---------------------------------------------------------------------------
create or replace function pll_validate_liability_eligibility() returns trigger as $$
declare
  liab_master_key text;
begin
  select master_item_key into liab_master_key from liabilities where id = new.liability_id;
  if liab_master_key is not null and liab_master_key in (
    'credit_card', 'store_card', 'car_loan', 'motorcycle_loan', 'boat_loan',
    'education_loan', 'hecs_help', 'tax_debt', 'ato_payment_plan',
    'family_loan', 'private_loan', 'buy_now_pay_later', 'medical_loan',
    'guarantees', 'margin_loan'
  ) then
    raise exception 'property_liability_links: liability % (catalogue item %) is a consumer/non-property debt type and cannot be linked as property finance', new.liability_id, liab_master_key
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pll_validate_liability on property_liability_links;
create trigger trg_pll_validate_liability
  before insert or update of liability_id on property_liability_links
  for each row execute function pll_validate_liability_eligibility();

-- ---------------------------------------------------------------------------
-- 5. RLS (spec s.53) -- same owner-only pattern as every other user-owned
--    table, PLUS explicit ownership checks on every referenced property and
--    liability id. auth.uid() = user_id alone is not sufficient here: an
--    attacker whose own user_id is correctly set could still attempt to
--    reference another tenant's property or liability row by guessing its
--    UUID (the FK only proves the row exists, not who owns it). The WITH
--    CHECK clause below closes that gap on both INSERT and UPDATE.
-- ---------------------------------------------------------------------------
alter table property_liability_links enable row level security;

drop policy if exists "own rows - property liability links" on property_liability_links;
create policy "own rows - property liability links" on property_liability_links
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and liability_id in (select id from liabilities where user_id = auth.uid())
    and (
      (linked_asset_id is not null and linked_asset_id in (select id from assets where user_id = auth.uid()))
      or (linked_investment_id is not null and linked_investment_id in (select id from investments where user_id = auth.uid()))
      or (linked_retirement_id is not null and linked_retirement_id in (select id from retirement_accounts where user_id = auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Conservative, deterministic-only backfill (spec s.37-43). Auto-links
--    ONLY when, for a given user: exactly one active property of the
--    matching type exists, exactly one active liability of the
--    corresponding catalogue type exists, AND owner + currency_code +
--    country_code all agree -- four independent corroborating signals,
--    deliberately never balance/amount/creation-time/category alone (spec
--    s.40). Any user with two-or-more candidates on either side, or a
--    mismatch on owner/currency/country, is left entirely unlinked
--    (ambiguous/no_match are never guessed -- spec s.43). Idempotent: the
--    NOT EXISTS guards mean re-running this migration creates nothing new
--    once a link (of any is_active state) already exists for that
--    property or liability id.
--
--    Commercial Property <-> Commercial Property Loan structurally matches
--    zero existing rows on first run, since 'commercial_loan' is a brand
--    new catalogue item seeded by this very migration -- no pre-existing
--    liability row could already carry it. This is expected and correctly
--    conservative, not a defect.
-- ---------------------------------------------------------------------------

-- Principal Residence <-> Home Loan => owner_occupied_mortgage
insert into property_liability_links
  (user_id, linked_asset_id, liability_id, link_type, allocation_percent, is_primary, source, confidence, notes)
select a.user_id, a.id, l.id, 'owner_occupied_mortgage', 100, true, 'backfill_deterministic', 'deterministic',
  'Auto-linked by migration 0078: exactly one active Principal Residence and exactly one active Home Loan for this user, with matching owner/currency/country.'
from assets a
join liabilities l
  on l.user_id = a.user_id
 and l.master_item_key = 'home_loan'
 and l.is_active = true
 and l.owner = a.owner
 and l.currency_code = a.currency_code
 and coalesce(l.country_code, '') = coalesce(a.country_code, '')
where a.master_item_key = 'principal_residence'
  and a.is_active = true
  and (select count(*) from assets a2 where a2.user_id = a.user_id and a2.master_item_key = 'principal_residence' and a2.is_active = true) = 1
  and (select count(*) from liabilities l2 where l2.user_id = a.user_id and l2.master_item_key = 'home_loan' and l2.is_active = true) = 1
  and not exists (select 1 from property_liability_links x where x.linked_asset_id = a.id)
  and not exists (select 1 from property_liability_links x where x.liability_id = l.id);

-- Residential Investment Property <-> Investment Loan => investment_property_loan
insert into property_liability_links
  (user_id, linked_investment_id, liability_id, link_type, allocation_percent, is_primary, source, confidence, notes)
select i.user_id, i.id, l.id, 'investment_property_loan', 100, true, 'backfill_deterministic', 'deterministic',
  'Auto-linked by migration 0078: exactly one active Residential Investment Property and exactly one active Investment Loan for this user, with matching owner/currency/country.'
from investments i
join liabilities l
  on l.user_id = i.user_id
 and l.master_item_key = 'investment_loan'
 and l.is_active = true
 and l.owner = i.owner
 and l.currency_code = i.currency_code
 and coalesce(l.country_code, '') = coalesce(i.country_code, '')
where i.master_item_key = 'property'
  and i.is_active = true
  and (select count(*) from investments i2 where i2.user_id = i.user_id and i2.master_item_key = 'property' and i2.is_active = true) = 1
  and (select count(*) from liabilities l2 where l2.user_id = i.user_id and l2.master_item_key = 'investment_loan' and l2.is_active = true) = 1
  and not exists (select 1 from property_liability_links x where x.linked_investment_id = i.id)
  and not exists (select 1 from property_liability_links x where x.liability_id = l.id);

-- Commercial Property <-> Commercial Property Loan => commercial_property_loan
insert into property_liability_links
  (user_id, linked_investment_id, liability_id, link_type, allocation_percent, is_primary, source, confidence, notes)
select i.user_id, i.id, l.id, 'commercial_property_loan', 100, true, 'backfill_deterministic', 'deterministic',
  'Auto-linked by migration 0078: exactly one active Commercial Property and exactly one active Commercial Property Loan for this user, with matching owner/currency/country.'
from investments i
join liabilities l
  on l.user_id = i.user_id
 and l.master_item_key = 'commercial_loan'
 and l.is_active = true
 and l.owner = i.owner
 and l.currency_code = i.currency_code
 and coalesce(l.country_code, '') = coalesce(i.country_code, '')
where i.master_item_key = 'commercial_property'
  and i.is_active = true
  and (select count(*) from investments i2 where i2.user_id = i.user_id and i2.master_item_key = 'commercial_property' and i2.is_active = true) = 1
  and (select count(*) from liabilities l2 where l2.user_id = i.user_id and l2.master_item_key = 'commercial_loan' and l2.is_active = true) = 1
  and not exists (select 1 from property_liability_links x where x.linked_investment_id = i.id)
  and not exists (select 1 from property_liability_links x where x.liability_id = l.id);

commit;
