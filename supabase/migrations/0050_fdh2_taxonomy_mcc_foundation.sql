-- =============================================================================
-- Financial Data Hub (FDH) — FDH-2 Migration A (0050): source registry,
-- economic-transaction-type reference table, category/subcategory taxonomy
-- extensions, and the MCC master + MCC-to-category mapping.
-- =============================================================================
-- SCOPE. FDH-2 builds the governed KNOWLEDGE layer only — no classification
-- engine, no parser, no transaction-classification execution. See
-- docs/financial-data-hub/FDH2_CATEGORY_TAXONOMY.md and FDH2_MCC_MAPPING.md.
--
-- REUSE RULE. fdh_categories and fdh_subcategories already exist
-- (migration 0045) as SCHEMA ONLY. This migration only ADDS columns via
-- `alter table ... add column` (all nullable or defaulted, so no existing row
-- — there are none yet in production — could ever be made invalid) and widens
-- two `check (... in (...))` constraints additively. No column is dropped, no
-- table is dropped, no existing constraint is narrowed.
--
-- STYLE. Matches migration 0045 exactly: `fdh_` prefix, text + check(in(...))
-- rather than `create type ... as enum`, lowercase snake_case values,
-- `for select using (true)` read policy on every master-data table, no
-- insert/update/delete policy for anon/authenticated (writes are
-- service-role-only, behind requireAdmin()).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_source_registry — a shared provenance-source list, so every FDH-2 row
-- that needs "where did this fact come from?" can carry a short foreign key
-- instead of repeating a long URL/description per row. See
-- FDH2_RESEARCH_EVIDENCE.md for the full source list this table's seed rows
-- summarise.
-- ---------------------------------------------------------------------------
create table fdh_source_registry (
  source_key text primary key check (source_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  source_name text not null,
  source_category text not null
    check (source_category in (
      'official_mcc_reference', 'institution_official_website',
      'public_company_information', 'government_official_source',
      'fhip_design_decision', 'industry_public_documentation', 'other'
    )),
  -- A short, non-scraped reference (a domain or a document name), never a
  -- verbatim copy of proprietary/closed content.
  source_reference_note text,
  accessed_at date,
  notes text,
  created_at timestamptz not null default now()
);

alter table fdh_source_registry enable row level security;
create policy "read fdh_source_registry" on fdh_source_registry for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_economic_transaction_types — descriptive metadata for the
-- economic_transaction_type vocabulary that migration 0045/0047 already
-- enforces via `check (... in (...))` on fdh_categories/fdh_transactions/etc.
--
-- This table does NOT replace the check constraint as the integrity
-- mechanism (that would be a schema change to FDH-1's established
-- text+check convention, which FDH-2 is not authorised to make). It exists
-- purely so a future UI/report can look up a display name and description
-- for a value it already has, and so this taxonomy has one governed,
-- queryable "economic_transaction_type_master" deliverable as the FDH-2
-- specification requires (section 100-105).
-- ---------------------------------------------------------------------------
create table fdh_economic_transaction_types (
  economic_type text primary key
    check (economic_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  display_name text not null,
  description text not null,
  created_at timestamptz not null default now()
);

alter table fdh_economic_transaction_types enable row level security;
create policy "read fdh_economic_transaction_types" on fdh_economic_transaction_types
  for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_categories extensions.
--
-- Fields added: fixed_variable, retirement_relevance, investment_relevance,
-- debt_relevance, source_key (provenance), effective_from, deprecated_at,
-- replacement_key (versioning — never delete a used category, retire it).
--
-- essential_discretionary is WIDENED (additively) to add 'user_dependent',
-- per FDH-2 specification section 12-20.
--
-- `tax_reporting_flag` (FDH-1, boolean) already fulfils the specification's
-- "tax_reporting_relevance — informational only" requirement: it is a plain
-- boolean flag, never a "deductible" assertion. FDH-2 does not rename it —
-- see FDH2_CATEGORY_TAXONOMY.md section 2 for the documented mapping
-- decision. Likewise `version` (FDH-1, int) already serves as
-- `taxonomy_version`; no rename.
-- ---------------------------------------------------------------------------
alter table fdh_categories
  add column fixed_variable text
    check (fixed_variable is null or fixed_variable in (
      'fixed', 'variable', 'semi_variable', 'user_dependent', 'not_applicable'
    )),
  add column retirement_relevance boolean not null default false,
  add column investment_relevance boolean not null default false,
  add column debt_relevance boolean not null default false,
  add column source_key text references fdh_source_registry(source_key) on delete set null,
  add column effective_from date,
  add column deprecated_at timestamptz,
  add column replacement_key text references fdh_categories(category_key) on delete set null,
  add constraint chk_fdh_categories_deprecation
    check (deprecated_at is null or active = false),
  add constraint chk_fdh_categories_replacement_needs_deprecation
    check (replacement_key is null or deprecated_at is not null),
  add constraint chk_fdh_categories_no_self_replacement
    check (replacement_key is null or replacement_key <> category_key);

alter table fdh_categories
  drop constraint if exists fdh_categories_essential_discretionary_check;
alter table fdh_categories
  add constraint fdh_categories_essential_discretionary_check
    check (essential_discretionary in ('essential', 'discretionary', 'mixed', 'user_dependent', 'not_applicable'));

create index idx_fdh_categories_source on fdh_categories(source_key) where source_key is not null;


-- ---------------------------------------------------------------------------
-- fdh_subcategories extensions — the same additive fields, plus a
-- UUID-referenced replacement (subcategory_key is only unique within its
-- parent category, not globally, so a text FK to a key would be ambiguous).
-- ---------------------------------------------------------------------------
alter table fdh_subcategories
  add column fixed_variable text
    check (fixed_variable is null or fixed_variable in (
      'fixed', 'variable', 'semi_variable', 'user_dependent', 'not_applicable'
    )),
  add column retirement_relevance boolean not null default false,
  add column investment_relevance boolean not null default false,
  add column debt_relevance boolean not null default false,
  add column source_key text references fdh_source_registry(source_key) on delete set null,
  add column effective_from date,
  add column deprecated_at timestamptz,
  add column replacement_subcategory_id uuid references fdh_subcategories(id) on delete set null,
  add constraint chk_fdh_subcategories_deprecation
    check (deprecated_at is null or active = false),
  add constraint chk_fdh_subcategories_replacement_needs_deprecation
    check (replacement_subcategory_id is null or deprecated_at is not null),
  add constraint chk_fdh_subcategories_no_self_replacement
    check (replacement_subcategory_id is null or replacement_subcategory_id <> id);

alter table fdh_subcategories
  drop constraint if exists fdh_subcategories_essential_discretionary_check;
alter table fdh_subcategories
  add constraint fdh_subcategories_essential_discretionary_check
    check (essential_discretionary in ('essential', 'discretionary', 'mixed', 'user_dependent', 'not_applicable'));

create index idx_fdh_subcategories_source on fdh_subcategories(source_key) where source_key is not null;


-- ---------------------------------------------------------------------------
-- fdh_mcc_master — the public MCC reference library. An MCC is an INPUT
-- SIGNAL, never an absolute classification (specification section 21-23).
-- ---------------------------------------------------------------------------
create table fdh_mcc_master (
  mcc char(4) primary key check (mcc ~ '^[0-9]{4}$'),
  official_or_public_description text not null,
  normalized_description text not null,
  broad_group text not null
    check (broad_group in (
      'retail_merchandise', 'grocery_supermarket', 'food_beverage', 'fuel_automotive',
      'utilities_telecom', 'transport_travel', 'health_medical', 'education',
      'financial_services', 'government_services', 'insurance', 'entertainment_recreation',
      'professional_services', 'wholesale_business', 'other'
    )),
  active boolean not null default true,
  source_key text references fdh_source_registry(source_key) on delete set null,
  source_version text,
  -- Which countries this code is relevant/observed for in FHIP's own
  -- research; MCCs are a global ISO-18245 vocabulary, so this is relevance,
  -- not jurisdiction.
  country_relevance char(2)[] not null default array['AU','IN']::char(2)[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_mcc_country_relevance
    check (array_length(country_relevance, 1) >= 1
           and country_relevance <@ array['AU','IN']::char(2)[])
);
create index idx_fdh_mcc_broad_group on fdh_mcc_master(broad_group) where active;

alter table fdh_mcc_master enable row level security;
create policy "read fdh_mcc_master" on fdh_mcc_master for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_mcc_category_map — MCC to category/subcategory. Deliberately NOT
-- over-mapped: when an MCC commonly covers materially different household
-- categories, category_id/subcategory_id are left NULL and
-- ambiguity_flag = true (specification section 21-23). A future
-- classification engine (FDH-6) combines MCC + merchant + description + user
-- rules to resolve ambiguity; FDH-2 must never force a false precision here.
-- ---------------------------------------------------------------------------
create table fdh_mcc_category_map (
  id uuid primary key default gen_random_uuid(),
  mcc char(4) not null references fdh_mcc_master(mcc) on delete cascade,
  -- NULL country_code = the mapping applies globally (AU and IN alike).
  country_code char(2) references countries(country_code) on delete restrict,
  category_id uuid references fdh_categories(id) on delete set null,
  subcategory_id uuid references fdh_subcategories(id) on delete set null,
  mapping_confidence text not null
    check (mapping_confidence in ('high', 'medium', 'low', 'context_required')),
  mapping_type text not null
    check (mapping_type in ('direct', 'broad_group_only', 'ambiguous_unmapped')),
  ambiguity_flag boolean not null default false,
  requires_additional_context boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  -- A subcategory-level mapping is meaningless without its parent category.
  constraint chk_fdh_mcc_map_subcategory_needs_category
    check (subcategory_id is null or category_id is not null),
  -- An ambiguous mapping must not sneak in false subcategory precision.
  constraint chk_fdh_mcc_map_ambiguous_no_subcategory
    check (not ambiguity_flag or subcategory_id is null),
  -- 'ambiguous_unmapped' must actually carry no category — otherwise the
  -- label and the data disagree, which is exactly the false-determinism the
  -- specification forbids.
  constraint chk_fdh_mcc_map_type_consistency
    check (mapping_type <> 'ambiguous_unmapped' or category_id is null)
);
-- One mapping per (mcc, country); NULL country is a single global row, kept
-- distinct from any country-specific override via coalesce.
create unique index uq_fdh_mcc_category_map on fdh_mcc_category_map(mcc, (coalesce(country_code, '**')));
create index idx_fdh_mcc_category_map_category on fdh_mcc_category_map(category_id) where category_id is not null;

alter table fdh_mcc_category_map enable row level security;
create policy "read fdh_mcc_category_map" on fdh_mcc_category_map for select using (true);
