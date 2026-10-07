-- Rollback of migration 0277 (dataset to metric mapping). Safe to run twice.
-- Restores the readiness function of migration 0275 first, because the stricter one reads the mapping table.
-- Live figures are not touched. The audit trail of mapping changes is dropped with its table.

create or replace function pb_dataset_readiness(p_dataset uuid, p_batch uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $fn$
declare
  d record;
  s record;
  b record;
  errs text[] := '{}';
  v_live integer;
  v_staged integer;
begin
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then return array['Dataset not found.']; end if;
  select * into s from public.benchmark_sources where id = d.benchmark_source_id;
  if not found then
    errs := array_append(errs, 'No source is linked to this dataset.');
  else
    if s.citation_text is null or length(trim(s.citation_text)) = 0 then errs := array_append(errs, 'Source citation is missing.'); end if;
    if s.publication_date is null and s.reference_period_start is null then errs := array_append(errs, 'Source period is missing.'); end if;
    if s.status not in ('approved', 'active') then
      errs := array_append(errs, 'Source status is ' || s.status || ' - it must be approved or active before this dataset can activate.');
    end if;
  end if;
  if d.data_status in ('suspended', 'archived', 'superseded') then
    errs := array_append(errs, 'Dataset status is ' || d.data_status || ' - it cannot receive an upload.');
  end if;
  if d.source_period is null or length(trim(d.source_period)) = 0 then errs := array_append(errs, 'Dataset source period is missing.'); end if;
  if d.geography_level is null or length(trim(d.geography_level)) = 0 then errs := array_append(errs, 'Dataset geography level is missing.'); end if;
  if d.statistic_coverage is null or length(trim(d.statistic_coverage)) = 0 then errs := array_append(errs, 'Dataset statistic coverage is missing.'); end if;
  if d.benchmark_class in ('observed_market', 'regulatory_statutory') then
    select count(*) into v_live from public.benchmark_values where dataset_id = p_dataset;
    select * into b from public.benchmark_upload_batches where id = p_batch;
    v_staged := 0;
    if found and b.kind = 'values' then
      select count(*) into v_staged from public.benchmark_upload_rows where batch_id = p_batch;
    end if;
    if v_live = 0 and v_staged = 0 then errs := array_append(errs, 'No benchmark value has been recorded for this dataset yet.'); end if;
  end if;
  return errs;
end;
$fn$;
revoke all on function pb_dataset_readiness(uuid, uuid) from public, anon, authenticated;

drop trigger if exists trg_benchmark_upload_rows_dataset_metric on benchmark_upload_rows;
drop function if exists pb_enforce_dataset_metric();
drop function if exists set_planning_benchmark_dataset_metric(uuid, text, boolean, boolean, text, boolean);
drop function if exists remove_planning_benchmark_dataset_metric(uuid, text, text, boolean);
drop function if exists pb_live_figures(uuid, uuid, text);
drop function if exists pb_staged_batches_using(uuid, uuid);
drop table if exists benchmark_dataset_metric_events;
drop table if exists benchmark_dataset_metrics;
drop function if exists benchmark_dataset_metric_events_append_only();
