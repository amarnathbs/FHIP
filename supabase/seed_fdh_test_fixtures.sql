-- =============================================================================
-- Financial Data Hub — MINIMAL DEV/TEST FIXTURES
-- =============================================================================
-- THIS IS NOT A MIGRATION and must never be applied to production.
--
-- It seeds only the handful of master rows the FDH-1 database/RLS tests
-- genuinely need in order to satisfy foreign keys. It is deliberately NOT an
-- attempt at the production data library:
--
--   * The exhaustive Australia/India institution master is FDH-2.
--   * The exhaustive category and subcategory library is FDH-2.
--   * Merchant research, the alias library, MCC mapping and seed
--     classification rules are FDH-2.
--
-- The rows below are marked with the `fixture_` key prefix so they are trivial
-- to identify and remove, and every institution name says TEST FIXTURE in
-- full so nobody mistakes one for a real institution.
--
-- Idempotent: safe to run repeatedly.
--
-- Depends on: migrations 0045-0048, and on `countries` / `currencies` from
-- migration 0001 (rows 'AU'/'IN' and 'AUD'/'INR' seeded there).
--
-- Apply with:  supabase SQL editor, or psql -f supabase/seed_fdh_test_fixtures.sql
-- =============================================================================

-- Institutions: one Australian bank, one Indian bank, one broker (used only to
-- prove the investment-boundary account types resolve; it is NOT an investment
-- ledger entry of any kind).
insert into fdh_financial_institutions (country_code, institution_code, institution_name, institution_type)
values
  ('AU', 'fixture_au_bank',   'TEST FIXTURE Australian Bank', 'bank'),
  ('IN', 'fixture_in_bank',   'TEST FIXTURE Indian Bank',     'bank'),
  ('AU', 'fixture_au_card',   'TEST FIXTURE Card Issuer',     'credit_card_issuer'),
  ('IN', 'fixture_in_broker', 'TEST FIXTURE Broker',          'broker')
on conflict (country_code, institution_code) do nothing;

-- Categories: two, one expense and one income, purely so the FK and the
-- economic-type check have something real to point at.
insert into fdh_categories (category_key, display_name, economic_type, country_applicability, essential_discretionary)
values
  ('fixture_groceries', 'TEST FIXTURE Groceries', 'expense', array['AU','IN']::char(2)[], 'essential'),
  ('fixture_salary',    'TEST FIXTURE Salary',    'income',  array['AU','IN']::char(2)[], 'not_applicable')
on conflict (category_key) do nothing;

insert into fdh_subcategories (category_id, subcategory_key, display_name, country_applicability)
select c.id, 'fixture_supermarket', 'TEST FIXTURE Supermarket', array['AU','IN']::char(2)[]
from fdh_categories c
where c.category_key = 'fixture_groceries'
on conflict (category_id, subcategory_key) do nothing;

-- One merchant plus one alias, to exercise the alias -> canonical mapping and
-- the governance status. `approved` here is a fixture convenience; in
-- production a merchant reaches `approved` only through admin review.
insert into fdh_merchants (canonical_name, display_name, country_code, merchant_type, verification_status, mcc)
values ('fixture_supermarket_co', 'TEST FIXTURE Supermarket Co', 'AU', 'grocery', 'approved', '5411')
on conflict do nothing;

insert into fdh_merchant_aliases (merchant_id, country_code, alias_normalised, alias_type, source, verified)
select m.id, 'AU', 'fixture supermkt co 1234', 'statement_narrative', 'admin_curated', true
from fdh_merchants m
where m.canonical_name = 'fixture_supermarket_co'
on conflict do nothing;

-- Parser registry + one version, so provenance tests have a real
-- (parser_id, parser_version_id) pair to record. NO PARSER CODE EXISTS —
-- these are registry rows only, and the version is `development`, never
-- `certified`, because nothing has been certified against a fixture set.
insert into fdh_parser_registry (parser_key, institution_id, document_type, source_format, country_code)
select 'fixture_au_bank_csv_v1', i.id, 'bank_statement', 'csv', 'AU'
from fdh_financial_institutions i
where i.country_code = 'AU' and i.institution_code = 'fixture_au_bank'
on conflict (parser_key) do nothing;

insert into fdh_parser_versions (parser_id, version, status, supported_layout_reference, notes)
select p.id, '0.0.1-fixture', 'development', 'none', 'TEST FIXTURE ONLY — no parser implementation exists in FDH-1.'
from fdh_parser_registry p
where p.parser_key = 'fixture_au_bank_csv_v1'
on conflict (parser_id, version) do nothing;
