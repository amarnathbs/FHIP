-- AR-0 §3.2 / Chunk 2 item 1: country/currency hard-block fix.
--
-- Adds an explicit, user-set `currency_override` flag to the four registers
-- that carry both a country_code and a currency_code (assets, liabilities,
-- investments, retirement_accounts — income/expense/insurance have no
-- country_code field and are unaffected). The application now hard-blocks a
-- save when currency_code doesn't match the country-derived expected
-- currency (AU -> AUD, IN -> INR; see lib/constants.ts's
-- COUNTRY_TO_CURRENCY and lib/validation/currencyCountry.ts), UNLESS this
-- flag is set. The flag is never defaulted true by user action alone; the
-- one exception is the 'foreign_currency' asset catalogue item, which is
-- inherently a deliberate cross-currency holding by design (see
-- FinancialDataGrid.tsx's rowFromMaster()).
--
-- Additive only: `not null default false` means every existing row is
-- unaffected (defaults to no override, matching today's implicit behaviour)
-- and this is a write-path validation change only — no existing row is
-- read-time rejected or altered by this migration.
--
-- NOT YET APPLIED to DEV or production — per this chunk's constraints, no
-- DDL execution capability exists in this sandbox. Until applied, the
-- currency_override field cannot actually persist; the client and server
-- code added alongside this migration degrade safely (currency_override is
-- simply undefined/false on read, so every row behaves exactly as before:
-- no override, hard block active on any genuine mismatch).

alter table assets
  add column if not exists currency_override boolean not null default false;

alter table liabilities
  add column if not exists currency_override boolean not null default false;

alter table investments
  add column if not exists currency_override boolean not null default false;

alter table retirement_accounts
  add column if not exists currency_override boolean not null default false;
