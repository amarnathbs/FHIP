-- Investment Intelligence R1 — Migration H: India adapter SHELL seed data.
-- Contributes rows, not schema, to the country-neutral core (ADR-005) — no
-- CAMS/KFintech/NSDL/CDSL parsing logic of any kind exists anywhere in this
-- migration or in application code (spec section 26, non-goals).
--
-- Governing docs: R0_SOURCE_PROVENANCE_CONTRACT.md section 1,
-- R1_IMPLEMENTATION_SPEC.md sections 7 and 11, R0_DOMAIN_ARCHITECTURE.md section 3.

-- ---------------------------------------------------------------------------
-- ii_sources — the 8 source rows R1_IMPLEMENTATION_SPEC.md section 7
-- requires. India-specific rows (cams/kfintech/mfcentral/nsdl/cdsl) carry
-- country_code='IN'; manual/admin_correction/broker are country-neutral
-- (null country_code) per R0_SOURCE_PROVENANCE_CONTRACT.md section 1.
-- parser_available is false for every row — no parser exists in R1.
-- ---------------------------------------------------------------------------
insert into ii_sources (source_key, source_label, source_category, country_code, is_active, parser_available) values
  ('cams', 'CAMS (Computer Age Management Services)', 'statement_provider', 'IN', true, false),
  ('kfintech', 'KFintech (KFin Technologies)', 'statement_provider', 'IN', true, false),
  ('mfcentral', 'MFCentral', 'statement_provider', 'IN', true, false),
  ('nsdl', 'NSDL (demat)', 'statement_provider', 'IN', true, false),
  ('cdsl', 'CDSL (demat)', 'statement_provider', 'IN', true, false),
  ('broker', 'Broker contract note / statement', 'broker', null, true, false),
  ('manual', 'Manual entry (no source document)', 'manual', null, true, false),
  ('admin_correction', 'Admin-applied correction', 'admin', null, true, false)
on conflict (source_key) do nothing;

-- ---------------------------------------------------------------------------
-- ii_instruments — a small, explicitly non-authoritative seed of common
-- India mutual-fund/index/retirement/deposit instruments for the manual
-- test importer's fixtures to reference (R1_IMPLEMENTATION_SPEC.md section
-- 11). This is NOT a real AMFI master feed import (explicit non-goal) —
-- status is 'provisional' throughout to accurately reflect that these rows
-- have not been verified against any live master-data source. Identifiers
-- in the companion insert below are clearly marked TESTFIX- placeholders,
-- not real production ISIN/AMFI codes, to avoid any appearance of asserting
-- verified real-world identifiers.
--
-- NPS is deliberately seeded with instrument_class='other' — the R0-frozen
-- ii_instruments.instrument_class enum (R0_CANONICAL_DATA_CONTRACT.md) has
-- no distinct "retirement" value, and R1 does not amend that frozen
-- enumeration without a documented architecture exception (none exists
-- here — R1_ARCHITECTURE_EXCEPTION.md states NONE). Future retirement-vs-
-- investment publish-target routing (R0_NET_WORTH_DEDUP_CONTRACT.md
-- scenario 6) can instead key off ii_accounts.account_type='retirement',
-- which already has that value today — no schema change required. See
-- docs/investment-intelligence/R1_DATABASE_SCHEMA.md for this reasoning.
-- ---------------------------------------------------------------------------
insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, isin, status) values
  ('11111111-1111-4111-8111-111111111101', 'HDFC Flexi Cap Fund - Growth (Direct Plan)', 'mutual_fund', 'IN', 'INR', null, 'provisional'),
  ('11111111-1111-4111-8111-111111111102', 'SBI Bluechip Fund - Growth (Direct Plan)', 'mutual_fund', 'IN', 'INR', null, 'provisional'),
  ('11111111-1111-4111-8111-111111111103', 'ICICI Prudential Nifty 50 Index Fund - Growth (Direct Plan)', 'mutual_fund', 'IN', 'INR', null, 'provisional'),
  ('11111111-1111-4111-8111-111111111104', 'National Pension System Tier I - Equity (E)', 'other', 'IN', 'INR', null, 'provisional'),
  ('11111111-1111-4111-8111-111111111105', 'Bank Fixed Deposit (generic, India)', 'fixed_deposit', 'IN', 'INR', null, 'provisional')
on conflict (id) do nothing;

insert into ii_instrument_identifiers (instrument_id, identifier_scheme, identifier_value, country_code, is_active) values
  ('11111111-1111-4111-8111-111111111101', 'amfi_scheme_code', 'TESTFIX-AMFI-HDFCFC-001', 'IN', true),
  ('11111111-1111-4111-8111-111111111101', 'internal_provisional', 'TESTFIX-PROV-HDFCFC-001', 'IN', true),
  ('11111111-1111-4111-8111-111111111102', 'amfi_scheme_code', 'TESTFIX-AMFI-SBIBC-001', 'IN', true),
  ('11111111-1111-4111-8111-111111111103', 'amfi_scheme_code', 'TESTFIX-AMFI-ICICIN50-001', 'IN', true)
on conflict do nothing;
