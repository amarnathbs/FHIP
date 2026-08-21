-- =============================================================================
-- Financial Data Hub (FDH) — FDH-1 Migration A (0045): reference / master-data
-- foundation.
-- =============================================================================
-- Every table in this migration is SHARED reference data. There is no user_id
-- anywhere in this file: an institution, a category, a merchant and a parser
-- are the same for every user. This mirrors the existing shared-reference
-- pattern already used by master_financial_items / goal_types / benchmark_*
-- (see docs/financial-data-hub/FDH0_RLS_BASELINE.md section 3e).
--
-- Read model:  `for select using (true)` — matches the existing convention.
-- Write model: NO insert/update/delete policy for anon/authenticated. Writes
--              happen exclusively through the service-role client behind
--              requireAdmin() (lib/services/adminAuth.ts:11-25), exactly as
--              every other master-data table in this schema already works.
--              This is also the structural enforcement of the FDH-1 rule
--              "a user correction must never automatically become a global
--              rule" — an ordinary session simply cannot write these tables.
--
-- Naming: `fdh_` prefix. Rationale in
-- docs/financial-data-hub/FDH1_DATABASE_SCHEMA.md section 1.
-- Enum style: text + check(... in (...)), matching the whole existing schema.
-- There is no `create type ... as enum` anywhere in migrations 0001-0030.
-- Casing: lowercase snake_case values, matching every existing table. The
-- FDH-1 specification writes these values in UPPER_CASE; the 1:1 mapping is
-- documented in docs/financial-data-hub/FDH1_DOMAIN_MODEL.md section 2.
--
-- SCOPE NOTE: FDH-1 is architecture + schema only. No parser, no upload, no
-- extraction and no classification engine is implemented here.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_source_types — the import MECHANISM, kept deliberately separate from
-- the institution. "Westpac" is an institution; "pdf_native" is how the data
-- arrived. A statement from the same institution may arrive by several
-- mechanisms over time, so these must not be one column.
-- Seeded in full below: this is a closed technical vocabulary, not a content
-- library, so seeding it here does not encroach on FDH-2.
-- ---------------------------------------------------------------------------
create table fdh_source_types (
  source_type_key text primary key
    check (source_type_key in (
      'csv', 'pdf_native', 'pdf_scanned', 'xlsx', 'manual_mapping',
      'cdr', 'account_aggregator', 'api', 'other'
    )),
  display_name text not null,
  -- true when a registered parser is required to interpret this mechanism.
  requires_parser boolean not null default false,
  -- true for mechanisms that are a live connection rather than a file.
  -- None are implemented in FDH-1; the column exists so the distinction is
  -- structural rather than guessed later.
  connected_source boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into fdh_source_types (source_type_key, display_name, requires_parser, connected_source) values
  ('csv',                'CSV file',                    true,  false),
  ('pdf_native',         'PDF (text layer)',            true,  false),
  ('pdf_scanned',        'PDF (scanned / image only)',  true,  false),
  ('xlsx',               'Excel workbook',              true,  false),
  ('manual_mapping',     'Manual mapping',              false, false),
  ('cdr',                'Consumer Data Right (AU)',    false, true),
  ('account_aggregator', 'Account Aggregator (India)',  false, true),
  ('api',                'Direct API / connector',      false, true),
  ('other',              'Other',                       false, false);

alter table fdh_source_types enable row level security;
create policy "read fdh_source_types" on fdh_source_types for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_financial_institutions — banks, card issuers, lenders, brokers, super /
-- retirement providers and payroll sources.
--
-- FDH-1 deliberately does NOT seed a production institution master. Only the
-- handful of rows the FDH-1 database tests genuinely need are seeded, and they
-- live in supabase/seed_fdh_test_fixtures.sql — a dev/test seed file,
-- deliberately NOT a migration, so no fictitious institution can ever reach
-- production. The full AU/India institution library is FDH-2 scope.
--
-- INVESTMENT BOUNDARY (Product Owner Decision 2): `broker`,
-- `investment_platform`, `depository` and `mutual_fund_platform` appear here
-- because FDH owns *document acquisition* from those institutions. This table
-- is NOT a canonical investment entity — Investment Intelligence owns
-- ii_instruments / ii_accounts / ii_transactions / ii_holding_snapshots /
-- ii_prices_nav. See docs/financial-data-hub/FDH1_INVESTMENT_BOUNDARY.md.
-- ---------------------------------------------------------------------------
create table fdh_financial_institutions (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(country_code) on delete restrict,
  institution_code text not null,
  institution_name text not null,
  institution_type text not null
    check (institution_type in (
      'bank', 'credit_card_issuer', 'lender', 'broker', 'investment_platform',
      'depository', 'mutual_fund_platform', 'super_fund',
      'retirement_provider', 'payroll_source', 'other'
    )),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An institution code is only unique within its country: "SBI" in India and
  -- a hypothetical "SBI" in Australia are different institutions.
  constraint uq_fdh_institutions_country_code unique (country_code, institution_code)
);
create index idx_fdh_institutions_country_type
  on fdh_financial_institutions(country_code, institution_type)
  where active;

alter table fdh_financial_institutions enable row level security;
create policy "read fdh_financial_institutions" on fdh_financial_institutions
  for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_categories — category master. SCHEMA ONLY in FDH-1.
--
-- `fhip_mapping_key` is forward-looking metadata for the FDH-15 FHIP Input
-- Data Bridge. Recording a key here creates NO integration whatsoever: no FDH
-- code reads it, and nothing in FDH writes to income_sources / expense_items /
-- assets / liabilities / investments / retirement_accounts /
-- insurance_policies. It exists so FDH-2 can populate the mapping without a
-- schema change.
-- ---------------------------------------------------------------------------
create table fdh_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique,          -- stable machine key, never a display label
  display_name text not null,
  description text,
  economic_type text not null
    check (economic_type in (
      'income', 'expense', 'transfer', 'investment', 'debt_principal',
      'debt_interest', 'refund', 'asset_purchase', 'asset_sale', 'tax',
      'fee', 'cash_withdrawal', 'unknown'
    )),
  -- Which countries this category applies to. FHIP already uses ISO-3166-1
  -- alpha-2 'AU'/'IN' (countries.country_code); no second convention is
  -- introduced.
  country_applicability char(2)[] not null default array['AU','IN']::char(2)[],
  essential_discretionary text
    check (essential_discretionary in ('essential', 'discretionary', 'mixed', 'not_applicable')),
  tax_reporting_flag boolean not null default false,
  fhip_mapping_key text,
  display_order int not null default 0,
  icon_key text,
  active boolean not null default true,
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_categories_country_applicability
    check (array_length(country_applicability, 1) >= 1
           and country_applicability <@ array['AU','IN']::char(2)[])
);
create index idx_fdh_categories_economic_type on fdh_categories(economic_type) where active;

alter table fdh_categories enable row level security;
create policy "read fdh_categories" on fdh_categories for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_subcategories — SCHEMA ONLY in FDH-1. The exhaustive AU/India library
-- is FDH-2 scope.
-- ---------------------------------------------------------------------------
create table fdh_subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references fdh_categories(id) on delete cascade,
  subcategory_key text not null,              -- stable machine key
  display_name text not null,
  description text,
  country_applicability char(2)[] not null default array['AU','IN']::char(2)[],
  essential_discretionary text
    check (essential_discretionary in ('essential', 'discretionary', 'mixed', 'not_applicable')),
  fhip_mapping_key text,
  display_order int not null default 0,
  active boolean not null default true,
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_fdh_subcategories_key unique (category_id, subcategory_key),
  constraint chk_fdh_subcategories_country_applicability
    check (array_length(country_applicability, 1) >= 1
           and country_applicability <@ array['AU','IN']::char(2)[])
);
create index idx_fdh_subcategories_category on fdh_subcategories(category_id) where active;

alter table fdh_subcategories enable row level security;
create policy "read fdh_subcategories" on fdh_subcategories for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_merchants — canonical merchant master. SCHEMA ONLY in FDH-1; no
-- merchant research and no exhaustive AU/India merchant library (FDH-2).
--
-- `verification_status` is the global-rule governance lifecycle. A separate
-- workflow table was considered and rejected as unnecessary complexity for a
-- five-state lifecycle; the states live on the row, exactly as
-- ii_instruments.status does.
--
-- CRITICAL RULE: a user correction must never automatically become a global
-- rule. Enforced structurally — this table has no insert/update policy for
-- authenticated users at all. User corrections are recorded in
-- fdh_user_classification_rules and fdh_classification_history (migration
-- 0047), which are user-owned.
-- ---------------------------------------------------------------------------
create table fdh_merchants (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,               -- normalised machine form
  display_name text not null,
  country_code char(2) references countries(country_code) on delete restrict,  -- null = country-neutral
  merchant_type text
    check (merchant_type in (
      'retail', 'grocery', 'utility', 'telecom', 'subscription', 'transport',
      'fuel', 'health', 'education', 'insurance', 'financial_institution',
      'government', 'entertainment', 'hospitality', 'other'
    )),
  default_category_id uuid references fdh_categories(id) on delete set null,
  default_subcategory_id uuid references fdh_subcategories(id) on delete set null,
  mcc text check (mcc is null or mcc ~ '^[0-9]{4}$'),
  subscription_possible boolean not null default false,
  essential_discretionary text
    check (essential_discretionary in ('essential', 'discretionary', 'mixed', 'not_applicable')),
  verification_status text not null default 'proposed'
    check (verification_status in ('proposed', 'admin_review', 'approved', 'rejected', 'merged')),
  merged_into_merchant_id uuid references fdh_merchants(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_merchants_merge_target
    check (verification_status <> 'merged' or merged_into_merchant_id is not null),
  constraint chk_fdh_merchants_no_self_merge
    check (merged_into_merchant_id is null or merged_into_merchant_id <> id)
);
-- Two partial unique indexes: a NULL country_code means "country-neutral", and
-- Postgres never treats two NULLs as equal, so a single unique constraint over
-- (country_code, canonical_name) would silently permit duplicate global rows.
create unique index uq_fdh_merchants_country_name
  on fdh_merchants(country_code, canonical_name) where country_code is not null;
create unique index uq_fdh_merchants_global_name
  on fdh_merchants(canonical_name) where country_code is null;
create index idx_fdh_merchants_verification on fdh_merchants(verification_status);

alter table fdh_merchants enable row level security;
create policy "read fdh_merchants" on fdh_merchants for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_merchant_aliases — many normalised statement narratives map to one
-- canonical merchant. SCHEMA ONLY; no alias library is populated in FDH-1.
-- ---------------------------------------------------------------------------
create table fdh_merchant_aliases (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references fdh_merchants(id) on delete cascade,
  country_code char(2) references countries(country_code) on delete restrict,
  alias_normalised text not null,
  alias_type text not null
    check (alias_type in (
      'statement_narrative', 'trading_name', 'legal_name', 'domain',
      'upi_handle', 'bpay_biller', 'other'
    )),
  -- `derived_from_user_data` means an admin promoted an observed pattern.
  -- It never happens automatically — see the CRITICAL RULE on fdh_merchants.
  source text not null
    check (source in ('admin_curated', 'imported_dataset', 'derived_from_user_data', 'external_reference')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  verified boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index uq_fdh_merchant_aliases
  on fdh_merchant_aliases(merchant_id, alias_normalised, coalesce(country_code, '**'));
create index idx_fdh_merchant_aliases_lookup
  on fdh_merchant_aliases(alias_normalised, country_code);

alter table fdh_merchant_aliases enable row level security;
create policy "read fdh_merchant_aliases" on fdh_merchant_aliases for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_classification_rules — centrally governed global classification rules.
--
-- match_definition / action_definition are STRUCTURED JSON, never an
-- executable expression: no eval, no SQL fragment, no regular-expression
-- string that is compiled unbounded. The check constraints below require an
-- object carrying a discriminator key; the full closed vocabulary is enforced
-- by the Zod discriminated unions in
-- lib/financial-data-hub/validation/classification.ts.
--
-- The classification ENGINE is not implemented in FDH-1 (FDH-6).
-- ---------------------------------------------------------------------------
create table fdh_classification_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  rule_type text not null
    check (rule_type in (
      'merchant_exact', 'merchant_alias', 'mcc', 'description_contains',
      'institution_narrative', 'source_provided_category'
    )),
  country_applicability char(2)[] not null default array['AU','IN']::char(2)[],
  match_definition jsonb not null,
  action_definition jsonb not null,
  priority int not null default 100,
  status text not null default 'proposed'
    check (status in ('proposed', 'admin_review', 'approved', 'rejected', 'merged')),
  active boolean not null default true,
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_rules_match_shape
    check (jsonb_typeof(match_definition) = 'object' and match_definition ? 'match_kind'),
  constraint chk_fdh_rules_action_shape
    check (jsonb_typeof(action_definition) = 'object' and action_definition ? 'action_kind'),
  constraint chk_fdh_rules_country_applicability
    check (array_length(country_applicability, 1) >= 1
           and country_applicability <@ array['AU','IN']::char(2)[])
);
create index idx_fdh_classification_rules_active
  on fdh_classification_rules(rule_type, priority) where active and status = 'approved';

alter table fdh_classification_rules enable row level security;
create policy "read fdh_classification_rules" on fdh_classification_rules
  for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_parser_registry / fdh_parser_versions — the parser provenance
-- foundation. NO PARSER IS IMPLEMENTED IN FDH-1.
--
-- Governing principle: "institution support is not one successful document."
-- Every processed statement must retain parser_id AND parser_version_id
-- (fdh_statement_uploads, migration 0046), so a later layout change can be
-- attributed and reprocessed rather than silently corrupting old data.
-- ---------------------------------------------------------------------------
create table fdh_parser_registry (
  id uuid primary key default gen_random_uuid(),
  parser_key text not null unique,
  -- Nullable: a generic CSV parser is not tied to one institution.
  institution_id uuid references fdh_financial_institutions(id) on delete restrict,
  document_type text not null
    check (document_type in (
      'bank_statement', 'credit_card_statement', 'loan_statement', 'payslip',
      'investment_statement', 'super_statement', 'epf_statement',
      'nps_statement', 'tax_document', 'other'
    )),
  source_format text not null references fdh_source_types(source_type_key) on delete restrict,
  country_code char(2) references countries(country_code) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_fdh_parser_registry_lookup
  on fdh_parser_registry(institution_id, document_type, source_format) where active;

alter table fdh_parser_registry enable row level security;
create policy "read fdh_parser_registry" on fdh_parser_registry for select using (true);

create table fdh_parser_versions (
  id uuid primary key default gen_random_uuid(),
  parser_id uuid not null references fdh_parser_registry(id) on delete cascade,
  version text not null,
  status text not null default 'development'
    check (status in ('development', 'certified', 'deprecated', 'disabled')),
  introduced_at timestamptz,
  retired_at timestamptz,
  supported_layout_reference text,
  notes text,
  created_at timestamptz not null default now(),
  constraint uq_fdh_parser_versions unique (parser_id, version),
  constraint chk_fdh_parser_versions_dates
    check (retired_at is null or introduced_at is null or retired_at >= introduced_at)
);
create index idx_fdh_parser_versions_parser on fdh_parser_versions(parser_id, status);

alter table fdh_parser_versions enable row level security;
create policy "read fdh_parser_versions" on fdh_parser_versions for select using (true);
