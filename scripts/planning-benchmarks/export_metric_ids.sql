-- READ-ONLY. Run in the Supabase SQL editor of the target environment (DEV first).
-- Returns the metric definition ids the first-load payload needs. The Admin API has no endpoint that lists
-- metric definitions, so this is the only input taken from the database. It changes nothing.
select coalesce(jsonb_agg(jsonb_build_object('metric_code', metric_code, 'id', id) order by metric_code), '[]'::jsonb) as metric_ids
from benchmark_metric_definitions;
