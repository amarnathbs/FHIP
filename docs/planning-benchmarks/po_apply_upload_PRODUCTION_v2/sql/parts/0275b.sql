-- PART B starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 3. Internal helpers (no EXECUTE for API roles - only the RPCs below call them)
-- ===========================================================================

-- The live band tiers of a target-range group that a batch would replace as a set but does not restate.
create or replace function pb_removed_band_ids(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(tr.id order by tr.id), '{}'::uuid[])
    from public.benchmark_target_ranges tr
   where (tr.effective_to is null or tr.effective_to > current_date)
     and exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type)
     and not exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type
          and (r.payload ->> 'band_tier')::integer = tr.band_tier);
$fn$;

-- Classify every staged row of a batch against the CURRENT live tables. Pure read.
--   new        no live figure for the key
--   unchanged  exactly one live figure, same dataset, same content (it is left alone, never duplicated)
--   changed    one or more live figures that this row replaces (they are end-dated on activation)
--   conflict   a live figure for the key belongs to another dataset (or a cohort differs, or the live
--              bands are cited by another source). A batch with a conflict cannot be activated.
create or replace function pb_classify_rows(p_batch uuid)
returns table (row_no integer, cls text, live_ids uuid[], detail text)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  b record;
begin
  select * into b from public.benchmark_upload_batches where id = p_batch;
  if not found then return; end if;

  if b.kind = 'values' then
    return query
    select r.row_no,
           case
             when coalesce(bool_or(d.dataset_name <> b.dataset_name), false) then 'conflict'
             when count(v.id) = 0 then 'new'
             when count(v.id) = 1 and coalesce(bool_and(v.dataset_id = b.dataset_id
                   and v.value_numeric = round((r.payload ->> 'value_numeric')::numeric, 4)
                   and v.unit is not distinct from (r.payload ->> 'unit')
                   and v.original_currency::text is not distinct from nullif(r.payload ->> 'original_currency', '')
                   and v.base_date is not distinct from nullif(r.payload ->> 'base_date', '')::date), false) then 'unchanged'
             else 'changed'
           end,
           coalesce(array_agg(v.id order by v.id) filter (where v.id is not null), '{}'::uuid[]),
           case
             when coalesce(bool_or(d.dataset_name <> b.dataset_name), false)
               then 'A live figure for this metric, cohort and statistic belongs to another dataset: ' || coalesce(string_agg(distinct d.dataset_name, ', ') filter (where d.dataset_name <> b.dataset_name), '')
             when count(v.id) > 1 then 'More than one live figure exists for this key. All of them are replaced.'
             else null
           end
      from public.benchmark_upload_rows r
      left join public.benchmark_values v
        on v.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
       and v.cohort_id is not distinct from nullif(r.payload ->> 'cohort_id', '')::uuid
       and v.statistic_type = r.payload ->> 'statistic_type'
       and (v.effective_to is null or v.effective_to > current_date)
      left join public.benchmark_datasets d on d.id = v.dataset_id
     where r.batch_id = p_batch
     group by r.row_no, r.payload;

  elsif b.kind = 'target_ranges' then
    return query
    select r.row_no,
           case
             when exists (
               select 1 from public.benchmark_target_ranges g
                where (g.effective_to is null or g.effective_to > current_date)
                  and g.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
                  and g.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
                  and g.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
                  and g.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
                  and g.benchmark_source_id is not null
                  and g.benchmark_source_id is distinct from (r.payload ->> 'source_id')::uuid) then 'conflict'
             when count(t.id) = 0 then 'new'
             when count(t.id) = 1 and coalesce(bool_and(t.band_label = (r.payload ->> 'band_label')
                   and t.lower_bound is not distinct from nullif(r.payload ->> 'lower_bound', '')::numeric
                   and t.upper_bound is not distinct from nullif(r.payload ->> 'upper_bound', '')::numeric
                   and t.direction = (r.payload ->> 'direction')
                   and t.evidence_level = (r.payload ->> 'evidence_level')
                   and t.model_version = (r.payload ->> 'model_version')
                   and t.benchmark_source_id is not distinct from (r.payload ->> 'source_id')::uuid), false) then 'unchanged'
             else 'changed'
           end,
           coalesce(array_agg(t.id order by t.id) filter (where t.id is not null), '{}'::uuid[]),
           case
             when exists (
               select 1 from public.benchmark_target_ranges g
                where (g.effective_to is null or g.effective_to > current_date)
                  and g.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
                  and g.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
                  and g.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
                  and g.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
                  and g.benchmark_source_id is not null
                  and g.benchmark_source_id is distinct from (r.payload ->> 'source_id')::uuid)
               then 'The live bands for this group are cited by a different source.'
             when count(t.id) > 1 then 'More than one live band exists for this tier. All of them are replaced.'
             else null
           end
      from public.benchmark_upload_rows r
      left join public.benchmark_target_ranges t
        on t.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
       and t.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
       and t.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
       and t.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
       and t.band_tier = (r.payload ->> 'band_tier')::integer
       and (t.effective_to is null or t.effective_to > current_date)
     where r.batch_id = p_batch
     group by r.row_no, r.payload;

  else
    return query
    select r.row_no,
           case
             when c.id is null then 'new'
             when c.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
              and c.region_code is not distinct from nullif(r.payload ->> 'region_code', '')
              and c.urban_rural is not distinct from nullif(r.payload ->> 'urban_rural', '')
              and c.age_band is not distinct from nullif(r.payload ->> 'age_band', '')
              and c.income_band is not distinct from nullif(r.payload ->> 'income_band', '')
              and c.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
              and c.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
              and c.housing_tenure is not distinct from nullif(r.payload ->> 'housing_tenure', '')
              and c.employment_type is not distinct from nullif(r.payload ->> 'employment_type', '')
              and c.dependant_band is not distinct from nullif(r.payload ->> 'dependant_band', '')
              and c.financial_dna_code is not distinct from nullif(r.payload ->> 'financial_dna_code', '')
              and c.cross_border_flag = (r.payload ->> 'cross_border_flag')::boolean
              and c.cohort_tier = (r.payload ->> 'cohort_tier')::integer
              and c.sample_size is not distinct from nullif(r.payload ->> 'sample_size', '')::integer
              and c.cohort_description = (r.payload ->> 'cohort_description') then 'unchanged'
             else 'conflict'
           end,
           case when c.id is null then '{}'::uuid[] else array[c.id] end,
           case when c.id is not null and not (
               c.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
               and c.cohort_tier = (r.payload ->> 'cohort_tier')::integer
               and c.cohort_description = (r.payload ->> 'cohort_description')
               and c.age_band is not distinct from nullif(r.payload ->> 'age_band', '')
               and c.region_code is not distinct from nullif(r.payload ->> 'region_code', '')
               and c.urban_rural is not distinct from nullif(r.payload ->> 'urban_rural', '')
               and c.income_band is not distinct from nullif(r.payload ->> 'income_band', '')
               and c.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
               and c.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
               and c.housing_tenure is not distinct from nullif(r.payload ->> 'housing_tenure', '')
               and c.employment_type is not distinct from nullif(r.payload ->> 'employment_type', '')
               and c.dependant_band is not distinct from nullif(r.payload ->> 'dependant_band', '')
               and c.financial_dna_code is not distinct from nullif(r.payload ->> 'financial_dna_code', '')
               and c.cross_border_flag = (r.payload ->> 'cross_border_flag')::boolean
               and c.sample_size is not distinct from nullif(r.payload ->> 'sample_size', '')::integer)
             then 'A cohort with this code already exists with different details. Cohorts cannot be edited here.'
             else null end
      from public.benchmark_upload_rows r
      left join public.benchmark_cohorts c on c.cohort_code = (r.payload ->> 'cohort_code')
     where r.batch_id = p_batch;
  end if;
end;
$fn$;

-- The digest an Activate is bound to: batch identity plus every row, its CURRENT classification, the live
-- rows it would replace and the bands that would be removed. If live data moves, the digest moves.
create or replace function pb_batch_digest(p_batch uuid) returns text
language sql stable security definer set search_path = '' as $fn$
  select encode(sha256(convert_to(
    coalesce((select b.kind || '|' || b.dataset_id::text || '|' || b.file_sha256 || '|' || b.template_version from public.benchmark_upload_batches b where b.id = p_batch), '')
    || chr(10) ||
    coalesce((select string_agg(r.row_no::text || ',' || c.cls || ',' || r.payload::text || ',' || coalesce(array_to_string(c.live_ids, ','), ''), chr(10) order by r.row_no)
                from public.benchmark_upload_rows r
                join public.pb_classify_rows(p_batch) c on c.row_no = r.row_no
               where r.batch_id = p_batch), '')
    || chr(10) || 'removed:' || coalesce(array_to_string(public.pb_removed_band_ids(p_batch), ','), ''),
    'UTF8')), 'hex');
$fn$;

-- Readiness of the target dataset for activation: the rules of validateDatasetForActivation
-- (lib/services/benchmarkGovernance.ts) with two deliberate differences. The source must be approved
-- or active (the original lets an under-review or superseded source through although its own message
-- says approved or active) and a suspended, archived or superseded dataset is refused. The rule that an
-- observed or regulatory dataset needs at least one value is met by the staged values themselves,
-- which is what lets a first load activate.
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

-- Recompute and store the classification of every staged row. Used only while staging.
create or replace function pb_store_classification(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_counts jsonb;
begin
  update public.benchmark_upload_rows r
     set classification = c.cls, live_ids = c.live_ids, detail = c.detail
    from public.pb_classify_rows(p_batch) c
   where r.batch_id = p_batch and r.row_no = c.row_no;
  select jsonb_build_object(
           'new', count(*) filter (where classification = 'new'),
           'changed', count(*) filter (where classification = 'changed'),
           'unchanged', count(*) filter (where classification = 'unchanged'),
           'conflict', count(*) filter (where classification = 'conflict'),
           'removed', coalesce(cardinality(public.pb_removed_band_ids(p_batch)), 0))
    into v_counts
    from public.benchmark_upload_rows where batch_id = p_batch;
  return v_counts;
end;
$fn$;

revoke all on function pb_removed_band_ids(uuid), pb_classify_rows(uuid), pb_batch_digest(uuid), pb_dataset_readiness(uuid, uuid), pb_store_classification(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
