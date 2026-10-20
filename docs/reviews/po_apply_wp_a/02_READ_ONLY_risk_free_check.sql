-- WP-A F2: confirm the governed risk-free series the Performance tab now reads. READ ONLY.
-- Run on DEV first, then production. Nothing here changes data.

-- QUERY 1: the two series, their switch, terms status and verification date.
select series_id, enabled, terms_review_status, cadence, max_staleness_days, verified_through_date
from ii_risk_free_series
order by series_id;

-- QUERY 2: the newest rates in the primary series (expect a value dated within the last 21 days).
select observation_date, kind, value_percent, gap_reason
from ii_risk_free_observations
where series_id = 'RBI_91D_TBILL_CUTOFF_YIELD'
order by observation_date desc
limit 12;

-- QUERY 3: how many rows the OLD table holds (the Performance tab used to read only this one; empty on production).
select count(*) as old_table_rows from ii_risk_free_rates;
