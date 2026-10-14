-- PART C starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 4. RPC: stage
-- ===========================================================================
-- p keys: kind, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version,
-- rows (array of objects keyed by the template column names, plus row_no).
create or replace function stage_planning_benchmark_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_kind text := p ->> 'kind';
  v_id uuid := gen_random_uuid();
  d record;
  v_rows jsonb := p -> 'rows';
  v_n integer;
  v_cnt integer;
  v_sha text := p ->> 'file_sha256';
  v_existing record;
  v_counts jsonb;
  v_digest text;
  v_expected_marker text;
begin
  if v_uid is null or not public.is_planning_benchmark_uploader() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  if v_kind is null or v_kind not in ('values', 'target_ranges', 'cohorts') then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: unknown upload kind';
  end if;
  v_expected_marker := case v_kind when 'values' then 'FHIP-PB-VALUES-1' when 'target_ranges' then 'FHIP-PB-RANGES-1' else 'FHIP-PB-COHORTS-1' end;
  if p ->> 'template_version' is distinct from v_expected_marker then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the template version marker does not match this upload kind';
  end if;
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the file hash is missing or malformed';
  end if;
  if coalesce((p ->> 'file_bytes')::integer, 0) <= 0 or length(coalesce(p ->> 'file_name', '')) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the file name or size is missing';
  end if;
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: rows must be an array';
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n < 1 or v_n > 5000 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: between 1 and 5000 rows are required';
  end if;

  select * into d from public.benchmark_datasets where dataset_name = p ->> 'dataset_name' and version = p ->> 'dataset_version';
  if not found then
    raise exception using errcode = '22023', message = 'PB_E_DATASET: no dataset exists with that name and version. An upload never creates a dataset';
  end if;
  if d.data_status in ('suspended', 'archived', 'superseded') then
    raise exception using errcode = '55000', message = 'PB_E_DATASET: the dataset is ' || d.data_status || ' and cannot receive an upload';
  end if;

  -- Every row must name the same dataset as the file.
  select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(dataset_name text, dataset_version text)
   where r.dataset_name is distinct from d.dataset_name or r.dataset_version is distinct from d.version;
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a different dataset than the file';
  end if;
  select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(row_no integer) where r.row_no is null or r.row_no < 1;
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: every row needs a positive row number';
  end if;
  select count(*) - count(distinct r.row_no) into v_cnt from jsonb_to_recordset(v_rows) as r(row_no integer);
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: duplicate row numbers';
  end if;

  -- Duplicate protection (idempotency per file hash).
  select id, activated_at into v_existing from public.benchmark_upload_batches
   where file_sha256 = v_sha and kind = v_kind and dataset_id = d.id and status = 'activated' limit 1;
  if found then
    raise exception using errcode = '23505', message = 'PB_E_DUPLICATE: this exact file was already activated for this dataset on ' || to_char(v_existing.activated_at, 'DD/MM/YYYY') || ' (batch ' || v_existing.id::text || ')';
  end if;
  select id, staged_at into v_existing from public.benchmark_upload_batches
   where file_sha256 = v_sha and kind = v_kind and dataset_id = d.id and status = 'staged' and expires_at > now() order by staged_at desc limit 1;
  if found then
    return jsonb_build_object('status', 'already_staged', 'batch_id', v_existing.id);
  end if;

  if v_kind = 'values' then
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text)
     where not exists (select 1 from public.benchmark_metric_definitions m where m.metric_code = r.metric_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a metric that is not registered'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text, unit text)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code where m.unit is distinct from r.unit;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) have a unit that differs to the unit the metric is defined in'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text)
     where nullif(r.cohort_code, '') is not null and not exists (select 1 from public.benchmark_cohorts c where c.cohort_code = r.cohort_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a cohort that does not exist'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(statistic_type text, value_numeric numeric, unit text, original_currency text, effective_from date, base_date date)
     where r.statistic_type is null or r.statistic_type not in ('mean', 'median', 'p10', 'p20', 'p25', 'p50', 'p75', 'p80', 'p90', 'target_min', 'target_max', 'threshold', 'rate', 'share')
        or r.value_numeric is null or abs(r.value_numeric) >= 100000000000000 or r.value_numeric <> round(r.value_numeric, 4)
        or r.unit is null or r.unit not in ('currency', 'percentage', 'months', 'ratio', 'count', 'years', 'days')
        or (r.unit = 'currency' and (r.original_currency is null or r.original_currency !~ '^[A-Z]{3}$'))
        or (r.unit <> 'currency' and nullif(r.original_currency, '') is not null)
        or r.effective_from > current_date or r.base_date > current_date;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a value rule (statistic, number, unit, currency or a date in the future)'; end if;
    select count(*) into v_cnt from (
      select 1 from jsonb_to_recordset(v_rows) as r(cohort_code text, metric_code text, statistic_type text)
       group by coalesce(r.cohort_code, ''), r.metric_code, r.statistic_type having count(*) > 1) x;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a metric, cohort and statistic key'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'metric_definition_id', m.id, 'metric_code', m.metric_code, 'cohort_id', c.id, 'cohort_code', nullif(r.cohort_code, ''),
             'statistic_type', r.statistic_type, 'value_numeric', r.value_numeric, 'unit', r.unit, 'original_currency', nullif(r.original_currency, ''),
             'base_date', r.base_date, 'effective_from', r.effective_from, 'is_derived', coalesce(r.is_derived, false),
             'derivation_method', nullif(r.derivation_method, ''), 'confidence_score', r.confidence_score, 'value_text', left(r.value_text, 1000),
             'provenance', jsonb_build_object('source_release', r.source_release, 'observation_period_start', r.observation_period_start,
               'observation_period_end', r.observation_period_end, 'source_file', r.source_file, 'source_locator', r.source_locator, 'retrieval_date', r.retrieval_date)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, cohort_code text, metric_code text, statistic_type text, value_numeric numeric, unit text, original_currency text,
             base_date date, effective_from date, is_derived boolean, derivation_method text, confidence_score numeric, value_text text, source_release text,
             observation_period_start date, observation_period_end date, source_file text, source_locator text, retrieval_date date)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code
      left join public.benchmark_cohorts c on c.cohort_code = nullif(r.cohort_code, '');

  elsif v_kind = 'target_ranges' then
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text)
     where not exists (select 1 from public.benchmark_metric_definitions m where m.metric_code = r.metric_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a metric that is not registered'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(source_name text)
     where (select count(*) from public.benchmark_sources s where s.source_name = r.source_name) <> 1
        or not exists (select 1 from public.benchmark_sources s where s.source_name = r.source_name and s.id = d.benchmark_source_id);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) cite a source that is not the one source of the dataset'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(country_code text)
     where nullif(r.country_code, '') is not null and not exists (select 1 from public.countries c where c.country_code::text = r.country_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name an unknown country'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(band_label text, band_tier integer, lower_bound numeric, upper_bound numeric, direction text, evidence_level text, model_version text, effective_from date)
     where nullif(r.band_label, '') is null or r.band_tier is null or r.band_tier not between 1 and 4
        or (r.lower_bound is null and r.upper_bound is null)
        or abs(coalesce(r.lower_bound, 0)) >= 100000000000000 or abs(coalesce(r.upper_bound, 0)) >= 100000000000000
        or r.lower_bound <> round(r.lower_bound, 4) or r.upper_bound <> round(r.upper_bound, 4)
        or r.lower_bound > r.upper_bound
        or r.direction is null or r.direction not in ('higher_better', 'lower_better', 'target_range')
        or r.evidence_level is null or r.evidence_level not in ('official_statistical', 'regulatory', 'research_informed', 'platform_derived')
        or nullif(r.model_version, '') is null or r.effective_from > current_date;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a band rule (tier, bounds, direction, evidence level or a date in the future)'; end if;
    select count(*) into v_cnt from (
      select 1 from jsonb_to_recordset(v_rows) as r(metric_code text, country_code text, life_stage text, household_type text, band_tier integer)
       group by r.metric_code, coalesce(r.country_code, ''), coalesce(r.life_stage, ''), coalesce(r.household_type, ''), r.band_tier having count(*) > 1) x;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a band key'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'metric_definition_id', m.id, 'metric_code', m.metric_code, 'source_id', d.benchmark_source_id, 'country_code', nullif(r.country_code, ''),
             'life_stage', nullif(r.life_stage, ''), 'household_type', nullif(r.household_type, ''), 'band_label', r.band_label, 'band_tier', r.band_tier,
             'lower_bound', r.lower_bound, 'upper_bound', r.upper_bound, 'direction', r.direction, 'explanation', nullif(r.explanation, ''),
             'evidence_level', r.evidence_level, 'model_version', r.model_version, 'effective_from', r.effective_from,
             'provenance', jsonb_build_object('source_release', r.source_release, 'observation_period_start', r.observation_period_start,
               'observation_period_end', r.observation_period_end, 'source_file', r.source_file, 'source_locator', r.source_locator, 'retrieval_date', r.retrieval_date)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, metric_code text, country_code text, life_stage text, household_type text, band_label text, band_tier integer,
             lower_bound numeric, upper_bound numeric, direction text, explanation text, evidence_level text, model_version text, effective_from date,
             source_release text, observation_period_start date, observation_period_end date, source_file text, source_locator text, retrieval_date date)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code;

  else
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text, country_code text, urban_rural text, cohort_tier integer, cohort_description text, sample_size integer)
     where r.cohort_code is null or r.cohort_code !~ '^[A-Za-z0-9_]+$' or r.cohort_tier is null or r.cohort_tier not between 1 and 5
        or nullif(r.cohort_description, '') is null
        or (nullif(r.urban_rural, '') is not null and r.urban_rural not in ('urban', 'rural', 'metro', 'regional'))
        or (nullif(r.country_code, '') is not null and not exists (select 1 from public.countries c where c.country_code::text = r.country_code))
        or r.sample_size < 0;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a cohort rule (code, tier, description, urban or rural value, country or sample size)'; end if;
    select count(*) - count(distinct r.cohort_code) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a cohort code'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'cohort_code', r.cohort_code, 'country_code', nullif(r.country_code, ''), 'region_code', nullif(r.region_code, ''), 'urban_rural', nullif(r.urban_rural, ''),
             'age_band', nullif(r.age_band, ''), 'income_band', nullif(r.income_band, ''), 'household_type', nullif(r.household_type, ''), 'life_stage', nullif(r.life_stage, ''),
             'housing_tenure', nullif(r.housing_tenure, ''), 'employment_type', nullif(r.employment_type, ''), 'dependant_band', nullif(r.dependant_band, ''),
             'financial_dna_code', nullif(r.financial_dna_code, ''), 'cross_border_flag', coalesce(r.cross_border_flag, false), 'cohort_tier', r.cohort_tier,
             'sample_size', r.sample_size, 'cohort_description', r.cohort_description,
             'provenance', jsonb_build_object('source_release', r.source_release, 'source_file', r.source_file, 'source_locator', r.source_locator)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, cohort_code text, country_code text, region_code text, urban_rural text, age_band text, income_band text,
             household_type text, life_stage text, housing_tenure text, employment_type text, dependant_band text, financial_dna_code text, cross_border_flag boolean,
             cohort_tier integer, sample_size integer, cohort_description text, source_release text, source_file text, source_locator text);
  end if;

  v_counts := public.pb_store_classification(v_id);
  v_digest := public.pb_batch_digest(v_id);
  update public.benchmark_upload_batches set counts = v_counts, staging_digest = v_digest where id = v_id;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (v_id, 'staged', v_uid, jsonb_build_object('kind', v_kind, 'dataset', d.dataset_name, 'dataset_version', d.version, 'rows', v_n, 'counts', v_counts, 'file_sha256', v_sha));
  return jsonb_build_object('status', 'staged', 'batch_id', v_id, 'counts', v_counts, 'staging_digest', v_digest);
end;
$fn$;

-- ===========================================================================
-- 5. RPC: get (preview with the diff against live values)
-- ===========================================================================
create or replace function get_planning_benchmark_upload(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  b record;
  v_rows jsonb;
  v_removed jsonb;
  v_ready text[];
  v_blockers text[] := '{}';
  v_digest_now text;
  v_conflicts integer;
begin
  if auth.uid() is null or not public.is_planning_benchmark_viewer() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  select * into b from public.benchmark_upload_batches where id = p_batch;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  v_ready := public.pb_dataset_readiness(b.dataset_id, p_batch);
  v_blockers := v_blockers || v_ready;
  select count(*) into v_conflicts from public.benchmark_upload_rows where batch_id = p_batch and classification = 'conflict';
  if v_conflicts > 0 then
    v_blockers := array_append(v_blockers, v_conflicts::text || ' row(s) conflict with live data and must be fixed in the file.');
  end if;
  if b.status = 'staged' then
    v_digest_now := public.pb_batch_digest(p_batch);
    if v_digest_now <> b.staging_digest then
      v_blockers := array_append(v_blockers, 'Live data changed after this upload was staged. Discard it and stage the file again.');
    end if;
    if b.expires_at <= now() then v_blockers := array_append(v_blockers, 'This staged upload expired. Discard it and stage the file again.'); end if;
  else
    v_blockers := array_append(v_blockers, 'This upload is ' || b.status || '.');
  end if;

  select coalesce(jsonb_agg(x.j order by x.rn), '[]'::jsonb) into v_rows from (
    select r.row_no as rn,
           jsonb_build_object(
             'row_no', r.row_no, 'classification', r.classification, 'detail', r.detail,
             'metric_code', r.payload ->> 'metric_code', 'cohort_code', r.payload ->> 'cohort_code', 'statistic_type', r.payload ->> 'statistic_type',
             'unit', r.payload ->> 'unit', 'band_label', r.payload ->> 'band_label', 'band_tier', r.payload ->> 'band_tier',
             'country_code', r.payload ->> 'country_code', 'life_stage', r.payload ->> 'life_stage', 'household_type', r.payload ->> 'household_type',
             'new_value', r.payload ->> 'value_numeric', 'new_lower', r.payload ->> 'lower_bound', 'new_upper', r.payload ->> 'upper_bound',
             'cohort_tier', r.payload ->> 'cohort_tier', 'cohort_description', r.payload ->> 'cohort_description',
             'live_value', (select v.value_numeric::text from public.benchmark_values v where v.id = r.live_ids[1]),
             'live_lower', (select t.lower_bound::text from public.benchmark_target_ranges t where t.id = r.live_ids[1]),
             'live_upper', (select t.upper_bound::text from public.benchmark_target_ranges t where t.id = r.live_ids[1])) as j
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch
     order by r.row_no
     limit 1000) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'metric_code', m.metric_code, 'band_label', t.band_label, 'band_tier', t.band_tier, 'lower', t.lower_bound::text, 'upper', t.upper_bound::text,
           'country_code', t.country_code::text, 'life_stage', t.life_stage, 'household_type', t.household_type) order by m.metric_code, t.band_tier), '[]'::jsonb)
    into v_removed
    from public.benchmark_target_ranges t
    join public.benchmark_metric_definitions m on m.id = t.metric_definition_id
   where t.id = any (public.pb_removed_band_ids(p_batch));

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'dataset_id', b.dataset_id, 'dataset_name', b.dataset_name, 'dataset_version', b.dataset_version, 'file_name', b.file_name,
      'file_sha256', b.file_sha256, 'file_bytes', b.file_bytes, 'template_version', b.template_version, 'status', b.status, 'row_count', b.row_count,
      'counts', b.counts, 'staging_digest', b.staging_digest, 'staged_by_me', b.staged_by = auth.uid(), 'staged_at', b.staged_at, 'expires_at', b.expires_at,
      'activated_at', b.activated_at, 'self_activated', b.self_activated, 'discarded_at', b.discarded_at, 'discard_reason', b.discard_reason, 'result', b.result),
    'readiness_errors', to_jsonb(v_ready),
    'blockers', to_jsonb(v_blockers),
    'rows', v_rows,
    'rows_truncated', b.row_count > 1000,
    'removed', v_removed);
end;
$fn$;

-- ===========================================================================
-- 6. RPC: activate (atomic apply)
-- ===========================================================================
-- p keys: expected_sha256, expected_digest, expected_counts (object), self_activation_ack (boolean).
create or replace function activate_planning_benchmark_upload(p_batch uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  b record;
  d record;
  v_digest text;
  v_ready text[];
  v_conflicts integer;
  v_ended integer := 0;
  v_inserted integer := 0;
  v_removed_ids uuid[];
  v_removed integer := 0;
  v_counts jsonb;
  v_prev_versions text;
  v_run uuid;
  v_result jsonb;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  -- One activation at a time, whatever the batch (taken before any row lock to keep one lock order).
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_upload_activate'));
  select * into b from public.benchmark_upload_batches where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  if b.status = 'activated' then
    return jsonb_build_object('status', 'already_activated', 'batch_id', b.id, 'result', b.result);
  end if;
  if b.status <> 'staged' then
    raise exception using errcode = '55000', message = 'PB_E_STATE: this upload is ' || b.status || ' and cannot be activated';
  end if;
  if b.expires_at <= now() then
    raise exception using errcode = '55000', message = 'PB_E_EXPIRED: this staged upload expired. Discard it and stage the file again';
  end if;
  if p ->> 'expected_sha256' is distinct from b.file_sha256 or p ->> 'expected_digest' is distinct from b.staging_digest then
    raise exception using errcode = '22023', message = 'PB_E_BINDING: the activation is not bound to the file and preview that were reviewed. Reload the preview';
  end if;
  if (p -> 'expected_counts') is distinct from b.counts then
    raise exception using errcode = '22023', message = 'PB_E_BINDING: the previewed counts differ than the staged counts. Reload the preview';
  end if;
  if b.staged_by = v_uid and coalesce((p ->> 'self_activation_ack')::boolean, false) is not true then
    raise exception using errcode = '42501', message = 'PB_E_SELF: you staged this upload. Activating it yourself needs the explicit self-activation acknowledgement';
  end if;

  v_digest := public.pb_batch_digest(p_batch);
  if v_digest <> b.staging_digest then
    raise exception using errcode = '55000', message = 'PB_E_STALE: live benchmark data changed after this upload was staged. Discard it and stage the file again';
  end if;
  select count(*) into v_conflicts from public.pb_classify_rows(p_batch) where cls = 'conflict';
  if v_conflicts > 0 then
    raise exception using errcode = '22023', message = 'PB_E_CONFLICT: ' || v_conflicts::text || ' row(s) conflict with live data';
  end if;
  v_ready := public.pb_dataset_readiness(b.dataset_id, p_batch);
  if coalesce(cardinality(v_ready), 0) > 0 then
    raise exception using errcode = '22023', message = 'PB_E_NOT_READY: ' || array_to_string(v_ready, ' ');
  end if;
  select * into d from public.benchmark_datasets where id = b.dataset_id for update;

  if b.kind = 'values' then
    select string_agg(distinct dd.version, ', ') into v_prev_versions
      from public.benchmark_values v join public.benchmark_datasets dd on dd.id = v.dataset_id
     where v.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed');
    update public.benchmark_values v set effective_to = current_date
     where v.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed');
    get diagnostics v_ended = row_count;
    insert into public.benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, value_text, unit, original_currency, base_date,
                                         is_derived, derivation_method, confidence_score, effective_from, version)
    select b.dataset_id, nullif(r.payload ->> 'cohort_id', '')::uuid, (r.payload ->> 'metric_definition_id')::uuid, r.payload ->> 'statistic_type',
           (r.payload ->> 'value_numeric')::numeric, nullif(r.payload ->> 'value_text', ''), r.payload ->> 'unit', nullif(r.payload ->> 'original_currency', ''),
           nullif(r.payload ->> 'base_date', '')::date, (r.payload ->> 'is_derived')::boolean, nullif(r.payload ->> 'derivation_method', ''),
           nullif(r.payload ->> 'confidence_score', '')::numeric, coalesce(nullif(r.payload ->> 'effective_from', '')::date, current_date),
           1 + coalesce((select max(o.version) from public.benchmark_values o where o.id = any (r.live_ids)), 0)
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification in ('new', 'changed');
    get diagnostics v_inserted = row_count;

  elsif b.kind = 'target_ranges' then
    v_removed_ids := public.pb_removed_band_ids(p_batch);
    v_removed := coalesce(cardinality(v_removed_ids), 0);
    update public.benchmark_target_ranges t set effective_to = current_date
     where t.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed')
        or t.id = any (v_removed_ids);
    get diagnostics v_ended = row_count;
    insert into public.benchmark_target_ranges (metric_definition_id, benchmark_source_id, country_code, life_stage, household_type, band_label, band_tier,
                                                lower_bound, upper_bound, direction, explanation, evidence_level, model_version, effective_from)
    select (r.payload ->> 'metric_definition_id')::uuid, (r.payload ->> 'source_id')::uuid, nullif(r.payload ->> 'country_code', ''), nullif(r.payload ->> 'life_stage', ''),
           nullif(r.payload ->> 'household_type', ''), r.payload ->> 'band_label', (r.payload ->> 'band_tier')::integer,
           nullif(r.payload ->> 'lower_bound', '')::numeric, nullif(r.payload ->> 'upper_bound', '')::numeric, r.payload ->> 'direction', nullif(r.payload ->> 'explanation', ''),
           r.payload ->> 'evidence_level', r.payload ->> 'model_version', coalesce(nullif(r.payload ->> 'effective_from', '')::date, current_date)
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification in ('new', 'changed');
    get diagnostics v_inserted = row_count;

  else
    insert into public.benchmark_cohorts (dataset_id, cohort_code, country_code, region_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure,
                                          employment_type, dependant_band, financial_dna_code, cross_border_flag, cohort_tier, sample_size, cohort_description)
    select b.dataset_id, r.payload ->> 'cohort_code', nullif(r.payload ->> 'country_code', ''), nullif(r.payload ->> 'region_code', ''), nullif(r.payload ->> 'urban_rural', ''),
           nullif(r.payload ->> 'age_band', ''), nullif(r.payload ->> 'income_band', ''), nullif(r.payload ->> 'household_type', ''), nullif(r.payload ->> 'life_stage', ''),
           nullif(r.payload ->> 'housing_tenure', ''), nullif(r.payload ->> 'employment_type', ''), nullif(r.payload ->> 'dependant_band', ''),
           nullif(r.payload ->> 'financial_dna_code', ''), (r.payload ->> 'cross_border_flag')::boolean, (r.payload ->> 'cohort_tier')::integer,
           nullif(r.payload ->> 'sample_size', '')::integer, r.payload ->> 'cohort_description'
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification = 'new';
    get diagnostics v_inserted = row_count;
  end if;

  -- The dataset becomes active (a first load cannot be activated by the existing button because it has no values yet).
  update public.benchmark_datasets set
    data_status = 'active',
    effective_from = case when d.data_status = 'active' and d.effective_from is not null then d.effective_from else current_date end,
    review_due_at = (current_date + interval '1 year')::date,
    approved_by = case when d.data_status = 'active' then d.approved_by else v_uid end,
    approved_at = case when d.data_status = 'active' then d.approved_at else now() end,
    updated_at = now()
  where id = b.dataset_id;

  -- Older versions of the same dataset left with no live value are marked superseded.
  if b.kind = 'values' then
    update public.benchmark_datasets o set data_status = 'superseded', effective_to = current_date, updated_at = now()
     where o.dataset_name = b.dataset_name and o.id <> b.dataset_id and o.data_status = 'active'
       and not exists (select 1 from public.benchmark_values v where v.dataset_id = o.id and (v.effective_to is null or v.effective_to > current_date));
  end if;

  v_counts := b.counts;
  insert into public.benchmark_update_runs (source_id, dataset_id, rows_imported, rows_rejected, validation_results, approval_status, previous_version, new_version, effective_date, audit_user, event_type)
  values (d.benchmark_source_id, b.dataset_id, v_inserted, 0,
          jsonb_build_object('upload_batch_id', b.id, 'kind', b.kind, 'file_sha256', b.file_sha256, 'counts', v_counts, 'rows_end_dated', v_ended, 'bands_removed', v_removed),
          'approved', v_prev_versions, d.version, current_date, v_uid, 'DATASET_IMPORT')
  returning id into v_run;

  v_result := jsonb_build_object('rows_inserted', v_inserted, 'rows_end_dated', v_ended, 'bands_removed', v_removed, 'counts', v_counts, 'update_run_id', v_run, 'dataset_status', 'active');
  update public.benchmark_upload_batches set
    status = 'activated', activated_by = v_uid, activated_at = now(), self_activated = (b.staged_by = v_uid), result = v_result, update_run_id = v_run
  where id = p_batch;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (p_batch, 'activated', v_uid, v_result || jsonb_build_object('self_activated', b.staged_by = v_uid));
  return jsonb_build_object('status', 'activated', 'batch_id', p_batch, 'result', v_result);
end;
$fn$;

-- ===========================================================================
-- 7. RPC: discard
-- ===========================================================================
create or replace function discard_planning_benchmark_upload(p_batch uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  b record;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
begin
  if v_uid is null or not public.is_planning_benchmark_viewer() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  select * into b from public.benchmark_upload_batches where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  -- An uploader may discard only a batch they staged. An activator may discard any batch.
  if not public.is_planning_benchmark_activator() and b.staged_by <> v_uid then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: you may discard only an upload you staged';
  end if;
  if b.status = 'discarded' then
    return jsonb_build_object('status', 'already_discarded', 'batch_id', b.id);
  end if;
  if b.status <> 'staged' then
    raise exception using errcode = '55000', message = 'PB_E_STATE: this upload is ' || b.status || ' and cannot be discarded';
  end if;
  update public.benchmark_upload_batches set status = 'discarded', discarded_by = v_uid, discarded_at = now(), discard_reason = v_reason where id = p_batch;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (p_batch, 'discarded', v_uid, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('status', 'discarded', 'batch_id', p_batch);
end;
$fn$;

revoke all on function stage_planning_benchmark_upload(jsonb), get_planning_benchmark_upload(uuid), activate_planning_benchmark_upload(uuid, jsonb), discard_planning_benchmark_upload(uuid, text) from public, anon;
grant execute on function stage_planning_benchmark_upload(jsonb), get_planning_benchmark_upload(uuid), activate_planning_benchmark_upload(uuid, jsonb), discard_planning_benchmark_upload(uuid, text) to authenticated;
