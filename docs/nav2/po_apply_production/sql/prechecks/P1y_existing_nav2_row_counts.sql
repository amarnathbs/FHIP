-- P1y (read only). Step 1b. Row counts of the six risk-free tables that already exist, and the two seed rows of the series table.
-- Expected on 17-10-2026: series 2 (the seed rows), every other table 0. If any other table holds rows, STOP: data would have to be preserved and reviewed before anything is applied.
select 'ii_risk_free_series' as table_name, count(*) as row_count from public.ii_risk_free_series
union all select 'ii_risk_free_batches', count(*) from public.ii_risk_free_batches
union all select 'ii_risk_free_observations', count(*) from public.ii_risk_free_observations
union all select 'ii_risk_free_review_items', count(*) from public.ii_risk_free_review_items
union all select 'ii_risk_free_corrections', count(*) from public.ii_risk_free_corrections
union all select 'ii_risk_free_series_state_log', count(*) from public.ii_risk_free_series_state_log
order by 1;
