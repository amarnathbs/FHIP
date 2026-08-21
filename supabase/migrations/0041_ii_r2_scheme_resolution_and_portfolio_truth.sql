-- Investment Intelligence R2 — Migration C: mutual-fund variant columns on
-- ii_instruments, the controlled scheme-alias mapping table, the Portfolio
-- Truth / certification status entity, the reconciliation-case structural
-- extension (spec section 26's named discrepancy_type enum + evidence
-- columns), and the versioned/configurable reconciliation-tolerance table
-- (spec section 25 — "not scattered magic numbers").
--
-- Additive only.
--
-- Governing docs: R2_SCHEME_RESOLUTION.md, R2_PORTFOLIO_TRUTH_AND_RECONCILIATION.md,
-- spec sections 17, 18, 24-29.

-- ---------------------------------------------------------------------------
-- ii_instruments — mutual-fund variant identification (spec section 18).
-- Direct-vs-Regular and Growth-vs-IDCW are, in AMFI reality, DIFFERENT
-- schemes with different codes/ISINs — each variant is its own
-- ii_instruments row (R0_CANONICAL_DATA_CONTRACT.md: "a specific
-- security/fund/scheme"), so no new instrument-identity concept is needed;
-- these are descriptive/filterable columns on the existing row, not a
-- second identity axis.
-- ---------------------------------------------------------------------------
alter table ii_instruments add column plan_type text check (plan_type is null or plan_type in ('direct', 'regular', 'not_applicable'));
alter table ii_instruments add column option_type text check (option_type is null or option_type in ('growth', 'idcw', 'dividend_payout', 'dividend_reinvestment', 'not_applicable'));
alter table ii_instruments add column amc_name text;

create index idx_ii_instruments_amc on ii_instruments(amc_name) where amc_name is not null;

-- ---------------------------------------------------------------------------
-- ii_scheme_alias_map — controlled alias mapping (spec section 17, priority
-- 5: "controlled alias mapping" — BEFORE falling back to manual
-- reconciliation, but AFTER isin/amfi_scheme_code/exact-identifier/
-- normalised-name matching). World-readable reference data, admin/system
-- write only, mirroring ii_instrument_identifiers' shape exactly. A row
-- here is a CURATED, reviewed mapping (e.g. a scheme renamed by the AMC,
-- or two RTAs printing the same scheme's name with cosmetically different
-- punctuation) — never populated by silent fuzzy-match auto-acceptance
-- (spec section 17: "fuzzy matching may produce a candidate with
-- confidence, but ambiguous mappings must create a reconciliation case").
-- ---------------------------------------------------------------------------
create table ii_scheme_alias_map (
  id uuid primary key default gen_random_uuid(),
  raw_scheme_name_normalised text not null, -- lower-cased, whitespace-collapsed source scheme name as it appears on statements
  amc_name text,
  plan_type text check (plan_type is null or plan_type in ('direct', 'regular', 'not_applicable')),
  option_type text check (option_type is null or option_type in ('growth', 'idcw', 'dividend_payout', 'dividend_reinvestment', 'not_applicable')),
  resolved_instrument_id uuid not null references ii_instruments(id),
  country_code char(2) references countries(country_code),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index uidx_ii_scheme_alias_map_key
  on ii_scheme_alias_map(raw_scheme_name_normalised, coalesce(plan_type, ''), coalesce(option_type, ''), coalesce(country_code, ''));
create index idx_ii_scheme_alias_map_instrument on ii_scheme_alias_map(resolved_instrument_id);

alter table ii_scheme_alias_map enable row level security;
create policy "read ii_scheme_alias_map" on ii_scheme_alias_map for select using (true);
-- No insert/update/delete policy for the authenticated role — admin/system
-- write only, identical discipline to ii_instrument_identifiers.

-- ---------------------------------------------------------------------------
-- ii_portfolio_truth_status — the CURRENT certification determination for
-- one canonical position (account_id, instrument_id), per spec sections 24
-- and 27. This is a MUTABLE "current state" row (like ii_fhip_publications),
-- not an immutable ledger — it is recomputed every time new evidence
-- (a fresh statement, a resolved reconciliation case) arrives, and always
-- points at the immutable history that justifies its current value
-- (latest_holding_snapshot_id, latest_source_document_id). One row per
-- position — unique(account_id, instrument_id).
-- ---------------------------------------------------------------------------
create table ii_portfolio_truth_status (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references ii_accounts(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id),
  status text not null default 'pending' check (status in (
    'pending', 'parsed', 'reconciliation_required', 'certified_with_warnings',
    'certified', 'failed', 'superseded', 'archived'
  )),
  history_completeness text check (history_completeness is null or history_completeness in (
    'complete_from_inception', 'complete_from_known_opening_balance', 'partial_history', 'holdings_only'
  )),
  latest_holding_snapshot_id uuid references ii_holding_snapshots(id),
  latest_source_document_id uuid references ii_source_documents(id),
  -- Reconciliation arithmetic (spec section 24): opening + inflows - outflows
  -- +/- adjustments, compared against the statement's own closing units.
  reconciled_opening_units numeric(20, 6),
  reconciled_closing_units numeric(20, 6), -- computed by replaying ii_transactions
  statement_closing_units numeric(20, 6), -- taken directly from the certified holding snapshot
  unit_variance numeric(20, 6),
  unit_variance_within_tolerance boolean,
  -- Data-quality dimensions (spec section 28) — transparent components, not
  -- one unexplained aggregate score. Each is independently nullable/settable.
  source_confidence numeric(5, 4) check (source_confidence is null or (source_confidence between 0 and 1)),
  parser_confidence numeric(5, 4) check (parser_confidence is null or (parser_confidence between 0 and 1)),
  owner_mapping_confidence numeric(5, 4) check (owner_mapping_confidence is null or (owner_mapping_confidence between 0 and 1)),
  instrument_mapping_confidence numeric(5, 4) check (instrument_mapping_confidence is null or (instrument_mapping_confidence between 0 and 1)),
  transaction_completeness_status text check (transaction_completeness_status is null or transaction_completeness_status in ('complete', 'partial', 'unknown')),
  holdings_reconciliation_status text check (holdings_reconciliation_status is null or holdings_reconciliation_status in ('matched', 'material_mismatch', 'within_tolerance', 'not_evaluated')),
  statement_freshness_days int, -- age, in days, of the latest certified statement as-of date at last evaluation time
  blocking_reasons jsonb not null default '[]'::jsonb, -- array of {code, message} — what is preventing CERTIFIED
  warning_reasons jsonb not null default '[]'::jsonb, -- array of {code, message} — what is preventing plain CERTIFIED but not blocking CERTIFIED_WITH_WARNINGS
  certified_at timestamptz,
  certified_by uuid, -- actor id (user/admin) who triggered the certifying evaluation; system-triggered when null with actor_type recorded only in the audit trail
  last_evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, instrument_id)
);
create index idx_ii_portfolio_truth_status_user on ii_portfolio_truth_status(user_id);
create index idx_ii_portfolio_truth_status_status on ii_portfolio_truth_status(user_id, status);

alter table ii_portfolio_truth_status enable row level security;
create policy "own ii_portfolio_truth_status" on ii_portfolio_truth_status
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_reconciliation_cases — structural extension (spec section 26).
-- discrepancy_type was a free `text not null` in migration 0035; R2 adds a
-- named check-constrained enum (documented decision, per the task's
-- explicit invitation to do so) without touching any existing row — every
-- value below is additive and every R1 fixture-driven case in
-- lib/fixtures/investment-intelligence/*.json already used
-- application-chosen free-text values that fit within this enum (verified
-- against the fixture files directly).
-- ---------------------------------------------------------------------------
alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in (
  'owner_unmatched', 'account_unmatched', 'instrument_unmatched', 'ambiguous_instrument',
  'transaction_unclassified', 'unit_mismatch', 'value_mismatch', 'duplicate_suspected',
  'missing_opening_history', 'unsupported_document', 'document_corrupt',
  'document_password_required', 'parse_incomplete', 'statement_period_gap', 'other'
)) not valid; -- NOT VALID: does not require scanning/locking existing rows to add; validated separately below

-- Validate now (safe — R1's only fixture-created case, in
-- lib/fixtures/investment-intelligence/04-discrepant-reconciliation.json,
-- already uses a value ('value_mismatch') that satisfies this constraint).
alter table ii_reconciliation_cases validate constraint ii_reconciliation_cases_discrepancy_type_check;

alter table ii_reconciliation_cases add column severity text not null default 'medium' check (severity in ('info', 'low', 'medium', 'high', 'blocking'));
alter table ii_reconciliation_cases add column source_document_id uuid references ii_source_documents(id);
alter table ii_reconciliation_cases add column evidence jsonb;
alter table ii_reconciliation_cases add column resolution_method text; -- e.g. 'user_mapped_instrument' | 'admin_override' | 'accepted_anomaly' | 'auto_resolved_on_reparse'
alter table ii_reconciliation_cases add column resolved_by uuid; -- actor id; app-validated against actor_type below, not a hard FK (same polymorphic-reference discipline as ii_fhip_publications.published_row_id)
alter table ii_reconciliation_cases add column resolved_by_actor_type text check (resolved_by_actor_type is null or resolved_by_actor_type in ('user', 'admin', 'system'));

create index idx_ii_reconciliation_cases_document on ii_reconciliation_cases(source_document_id) where source_document_id is not null;
create index idx_ii_reconciliation_cases_severity on ii_reconciliation_cases(user_id, severity, status);

-- ---------------------------------------------------------------------------
-- ii_reconciliation_config — versioned, configurable reconciliation
-- tolerances (spec section 25: "not scattered magic numbers ... keep
-- tolerances configurable/versioned"). World-readable, admin/system write.
-- Exactly one row has is_active = true at a time; application code falls
-- back to the hardcoded DEFAULT_RECONCILIATION_CONFIG constant in
-- lib/services/investment-intelligence/reconciliationConfig.ts if this table
-- is unreachable (e.g. pre-migration-application test runs) — the fallback
-- constant and this table's seed row are required to hold identical values,
-- checked by a unit test.
-- ---------------------------------------------------------------------------
create table ii_reconciliation_config (
  id uuid primary key default gen_random_uuid(),
  config_version text not null unique,
  unit_tolerance numeric(20, 6) not null,
  currency_tolerance numeric(18, 2) not null,
  statement_freshness_warning_days int not null,
  is_active boolean not null default false,
  notes text,
  created_at timestamptz default now()
);
create unique index uidx_ii_reconciliation_config_one_active
  on ii_reconciliation_config((true))
  where is_active = true;

alter table ii_reconciliation_config enable row level security;
create policy "read ii_reconciliation_config" on ii_reconciliation_config for select using (true);

insert into ii_reconciliation_config (config_version, unit_tolerance, currency_tolerance, statement_freshness_warning_days, is_active, notes) values
  ('r2-default-1.0.0', 0.0001, 1.00, 120, true, 'R2 initial default — unit tolerance 0.0001 (matches AMFI 4-decimal-unit statement precision), currency tolerance 1.00 major unit (INR/AUD rounding), statement considered stale for freshness warnings after 120 days.');
