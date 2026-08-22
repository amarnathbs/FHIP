-- =============================================================================
-- Financial Data Hub (FDH) — FDH-2 Migration B (0051): institution
-- capability/coverage/alias intelligence and the payment-rail master.
-- =============================================================================
-- REUSE RULE. fdh_financial_institutions already exists (migration 0045). This
-- migration only ADDS columns (all nullable or defaulted) and widens the
-- existing institution_type check constraint additively — see
-- lib/financial-data-hub/constants/enums.ts FDH_INSTITUTION_TYPES for the
-- rationale (adds government_payment_source, payment_processor).
--
-- COVERAGE STATUS. Every FDH-2-seeded institution is set to 'master_only' in
-- migration 0054's seed data. No institution may be seeded at
-- 'parser_certified' or any other status implying working parser support —
-- none exists yet (FDH-3+). This is enforced by convention here and checked
-- in tests/unit/fdh2SchemaContract.test.ts against the actual seed data.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_financial_institutions extensions.
-- ---------------------------------------------------------------------------
alter table fdh_financial_institutions
  add column coverage_status text not null default 'master_only'
    check (coverage_status in (
      'master_only', 'parser_planned', 'parser_in_development',
      'parser_certified', 'connected_data_future', 'deprecated'
    )),
  add column legal_name text,
  add column parent_group text,
  add column website_domain text,
  add column source_key text references fdh_source_registry(source_key) on delete set null,
  add column source_checked_at date;

alter table fdh_financial_institutions
  drop constraint if exists fdh_financial_institutions_institution_type_check;
alter table fdh_financial_institutions
  add constraint fdh_financial_institutions_institution_type_check
    check (institution_type in (
      'bank', 'credit_card_issuer', 'lender', 'broker', 'investment_platform',
      'depository', 'mutual_fund_platform', 'super_fund', 'retirement_provider',
      'payroll_source', 'government_payment_source', 'payment_processor', 'other'
    ));

create index idx_fdh_institutions_coverage on fdh_financial_institutions(coverage_status);


-- ---------------------------------------------------------------------------
-- fdh_institution_capabilities — an institution may have MULTIPLE
-- capabilities (e.g. a bank that is also a super-fund trustee brand) without
-- duplicating the institution row (specification section 24-28). The primary
-- `institution_type` column stays the institution's PRIMARY declared
-- identity; this table records additional ones.
-- ---------------------------------------------------------------------------
create table fdh_institution_capabilities (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references fdh_financial_institutions(id) on delete cascade,
  capability_type text not null
    check (capability_type in (
      'bank', 'credit_card_issuer', 'lender', 'broker', 'investment_platform',
      'depository', 'mutual_fund_platform', 'super_fund', 'retirement_provider',
      'payroll_source', 'government_payment_source', 'payment_processor', 'other'
    )),
  created_at timestamptz not null default now(),
  constraint uq_fdh_institution_capability unique (institution_id, capability_type)
);
create index idx_fdh_institution_capabilities_institution on fdh_institution_capabilities(institution_id);

alter table fdh_institution_capabilities enable row level security;
create policy "read fdh_institution_capabilities" on fdh_institution_capabilities
  for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_institution_aliases — e.g. COMMONWEALTH BANK / CBA / COMMONWEALTH BANK
-- OF AUSTRALIA all resolve to one canonical institution. No speculative
-- aliases without evidence (specification section 24-28).
-- ---------------------------------------------------------------------------
create table fdh_institution_aliases (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references fdh_financial_institutions(id) on delete cascade,
  alias text not null,
  alias_normalized text not null,
  source text not null check (source in ('admin_curated', 'imported_dataset', 'external_reference')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  verified boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint uq_fdh_institution_alias unique (institution_id, alias_normalized)
);
create index idx_fdh_institution_alias_lookup on fdh_institution_aliases(alias_normalized);

alter table fdh_institution_aliases enable row level security;
create policy "read fdh_institution_aliases" on fdh_institution_aliases for select using (true);


-- ---------------------------------------------------------------------------
-- fdh_payment_rail_master — a payment MECHANISM (EFTPOS, BPAY, OSKO, PAYID,
-- UPI, IMPS, NEFT, RTGS, ...), kept structurally separate from economic
-- classification. A payment rail is metadata about HOW money moved, never
-- WHAT it was for (specification section 38-43 — explicitly critical: UPI,
-- BPAY, OSKO, PAYID etc. must never be treated as expense categories).
-- ---------------------------------------------------------------------------
create table fdh_payment_rail_master (
  rail_key text primary key check (rail_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  display_name text not null,
  -- NULL country_code = a global mechanism (WIRE, TRANSFER, CASH, OTHER).
  country_code char(2) references countries(country_code) on delete restrict,
  rail_category text not null
    check (rail_category in (
      'card', 'direct_debit', 'direct_credit', 'bill_payment', 'p2p_transfer',
      'atm', 'wire', 'cash', 'other'
    )),
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_fdh_payment_rail_country on fdh_payment_rail_master(country_code);

alter table fdh_payment_rail_master enable row level security;
create policy "read fdh_payment_rail_master" on fdh_payment_rail_master for select using (true);
