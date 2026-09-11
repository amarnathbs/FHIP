-- G6 Contract 3 (docs/country-programme/g6-data-contracts.md) — FX-rate
-- lineage on financial_snapshots. Additive, forward-only, no data
-- migration: populated at write-time only (loadDashboard()'s upsert),
-- never backfilled for historical rows — a pre-G6 snapshot legitimately
-- has NULL here, meaning "rate unknown, do not attempt retroactive
-- reconciliation," matching this programme's "treat unavailable as
-- unavailable, not zero" rule (same convention as G6 Contract 2's
-- country_code columns).
alter table financial_snapshots add column fx_rate_aud_inr numeric(12,6);
alter table financial_snapshots add column fx_rate_date date;
