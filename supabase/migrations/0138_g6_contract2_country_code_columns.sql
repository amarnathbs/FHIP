-- G6 Contract 2 (docs/country-programme/g6-data-contracts.md) — adds
-- country_code to the three registers that never had one: income_sources,
-- expense_items, insurance_policies. assets/liabilities/investments/
-- retirement_accounts already have this column (G6 Contract 1 only widens
-- its accepted value set at the validation layer; no schema change there).
--
-- Additive, forward-only, no data migration: nullable, no default, no
-- backfill. Every existing row gets NULL (unattributed) — a permanent,
-- valid state for pre-G6 rows, not a transient one to be cleaned up later,
-- per this programme's "preserve existing source values, never rewrite
-- history" data-integrity rule (same convention as G6 Contract 3's
-- fx_rate_aud_inr/fx_rate_date columns on financial_snapshots).
alter table income_sources add column country_code char(2) references countries(country_code);
alter table expense_items add column country_code char(2) references countries(country_code);
alter table insurance_policies add column country_code char(2) references countries(country_code);
