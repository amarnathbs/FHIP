-- ---------------------------------------------------------------------------
-- PART D starts here: commit_risk_free_upload and record_risk_free_refresh_results
-- ---------------------------------------------------------------------------
-- 6. commit_risk_free_upload -- the admin CSV write path
--    p_rows: [{ date: yyyy-mm-dd, value_percent: 5.5199 | null, kind: value|gap,
--               gap_reason: null|no_accepted_bids|no_auction_held|no_row_in_source, source_document: ...,
--               source_url: ...|null, retrieved_on: yyyy-mm-dd, notes: ...|null }]
--    A row for an existing (series, date) with the SAME value is an identical skip, with a DIFFERENT
--    value the whole upload is refused (a published value is changed only by correct_risk_free_observation()).
-- ---------------------------------------------------------------------------
create or replace function commit_risk_free_upload(
  p_series_id text,
  p_file_sha256 text,
  p_file_name text,
  p_rows jsonb,
  p_attested boolean,
  p_attestation_text text,
  p_entry_kind text default 'admin_upload',
  p_verified_through date default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_existing record;
  v_batch uuid := gen_random_uuid();
  v_count integer;
  v_distinct integer;
  v_bad integer;
  v_conflicts integer;
  v_inserted integer;
  v_identical integer;
  v_from date;
  v_to date;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free upload: not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ii_risk_free_series where series_id = p_series_id) then
    raise exception 'risk-free upload: unknown series' using errcode = '22023';
  end if;
  if p_entry_kind not in ('first_load_csv', 'admin_upload') then
    raise exception 'risk-free upload: invalid entry kind' using errcode = '22023';
  end if;
  if p_attested is distinct from true or p_attestation_text is null or length(trim(p_attestation_text)) < 20 then
    raise exception 'risk-free upload: the attestation is required' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'risk-free upload: a SHA-256 file hash is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'risk-free upload: rows must be a non-empty array of at most 5000 entries' using errcode = '22023';
  end if;
  if p_verified_through is not null and p_verified_through > current_date then
    raise exception 'risk-free upload: the verified-through date cannot be in the future' using errcode = '22023';
  end if;

  select * into v_existing from public.ii_risk_free_batches
   where series_id = p_series_id and file_sha256 = p_file_sha256 and source_kind = 'admin_csv';
  if found then
    -- The same file again. Its rows are already in, only a NEW verified_through confirmation (the day a policy-change
    -- series was last confirmed complete) is applied, and it is recorded in the append-only state log (who, when, to what).
    if p_verified_through is not null
       and exists (select 1 from public.ii_risk_free_series x where x.series_id = p_series_id and (x.verified_through_date is null or x.verified_through_date < p_verified_through)) then
      -- Only a date that moves the confirmation FORWARD is applied and logged, an earlier or equal date is a no-op.
      update public.ii_risk_free_series
         set verified_through_date = p_verified_through, updated_at = now()
       where series_id = p_series_id;
      insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
      select s.series_id, s.enabled, s.enabled, s.terms_review_status, s.terms_review_status,
             'Verified-through date confirmed through ' || to_char(p_verified_through, 'DD-MM-YYYY') || ' (re-submitted file).', v_uid
        from public.ii_risk_free_series s where s.series_id = p_series_id;
    end if;
    return jsonb_build_object('already_committed', true, 'batch_id', v_existing.id, 'inserted', v_existing.rows_inserted, 'identical', v_existing.rows_identical_skipped, 'verified_through_recorded', p_verified_through is not null);
  end if;

  create temporary table if not exists tmp_rf_in (
    d date, kind text, v numeric(9,4), gap_reason text, doc text, url text, retrieved date, notes text
  ) on commit drop;
  truncate tmp_rf_in;
  insert into tmp_rf_in
    select (r->>'date')::date, coalesce(r->>'kind', 'value'),
           case when r->>'value_percent' is null then null else (r->>'value_percent')::numeric(9,4) end,
           nullif(r->>'gap_reason', ''), r->>'source_document', nullif(r->>'source_url', ''),
           (r->>'retrieved_on')::date, nullif(r->>'notes', '')
    from jsonb_array_elements(p_rows) r;

  select count(*), count(distinct d) into v_count, v_distinct from tmp_rf_in;
  if v_count <> v_distinct then
    raise exception 'risk-free upload: duplicate dates inside the file' using errcode = '22023';
  end if;
  select count(*) into v_bad from tmp_rf_in
   where d is null or retrieved is null or d > retrieved
      or doc is null or length(trim(doc)) = 0
      or kind not in ('value', 'gap')
      or (kind = 'value' and (v is null or v < 0 or v > 100 or gap_reason is not null))
      or (kind = 'gap' and (v is not null or gap_reason not in ('no_accepted_bids', 'no_auction_held', 'no_row_in_source')));
  if v_bad > 0 then
    raise exception using message = 'risk-free upload: ' || v_bad::text || ' row(s) fail validation (date, value range, future date, source document or gap rules)', errcode = '22023';
  end if;

  select count(*) into v_conflicts
    from tmp_rf_in t join public.ii_risk_free_observations o on o.series_id = p_series_id and o.observation_date = t.d
   where o.kind is distinct from t.kind or o.value_percent is distinct from t.v;
  if v_conflicts > 0 then
    raise exception using message = 'risk-free upload: ' || v_conflicts::text || ' date(s) already hold a different published value, a published value is changed only by an explicit correction', errcode = '22023';
  end if;

  select count(*) into v_identical
    from tmp_rf_in t join public.ii_risk_free_observations o on o.series_id = p_series_id and o.observation_date = t.d;
  select min(d), max(d) into v_from, v_to from tmp_rf_in;

  insert into public.ii_risk_free_batches (id, series_id, source_kind, file_name, file_sha256, rows_submitted, rows_inserted, rows_identical_skipped, date_from, date_to, uploader_user_id, attested, attestation_text, attested_at)
  values (v_batch, p_series_id, 'admin_csv', left(p_file_name, 255), p_file_sha256, v_count, v_count - v_identical, v_identical, v_from, v_to, v_uid, true, p_attestation_text, now());

  insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, batch_id)
  select p_series_id, t.d, t.kind, t.v, t.gap_reason, t.doc, t.url, t.retrieved, t.notes, p_entry_kind, v_batch
    from tmp_rf_in t
   where not exists (select 1 from public.ii_risk_free_observations o where o.series_id = p_series_id and o.observation_date = t.d);
  get diagnostics v_inserted = row_count;

  if p_verified_through is not null then
    update public.ii_risk_free_series
       set verified_through_date = greatest(coalesce(verified_through_date, p_verified_through), p_verified_through), updated_at = now()
     where series_id = p_series_id;
  end if;
  return jsonb_build_object('already_committed', false, 'batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical);
end $fn$;
revoke all on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) from public, anon;
grant execute on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. record_risk_free_refresh_results -- the weekly jobs write path (service role only)
--    p_rows: same shape as above plus extraction (jsonb). A value row for an existing date with a
--    DIFFERENT value is never written: it becomes a review item. Same value = identical skip.
--    p_review_items: [{ observation_date: ..., reasons: [...], candidate: {...}, evidence: {...} }]
-- ---------------------------------------------------------------------------
create or replace function record_risk_free_refresh_results(
  p_series_id text,
  p_rows jsonb,
  p_review_items jsonb,
  p_verified_through date
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_batch uuid := gen_random_uuid();
  v_inserted integer := 0;
  v_identical integer := 0;
  v_queued integer := 0;
  v_row jsonb;
  v_rev jsonb;
  v_existing record;
  v_date date;
  v_kind text;
  v_val numeric(9,4);
  v_n integer;
begin
  -- Database layer: only the service role (the cron route) may call this.
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'risk-free refresh: service role only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ii_risk_free_series where series_id = p_series_id) then
    raise exception 'risk-free refresh: unknown series' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_batches (id, series_id, source_kind, rows_submitted, rows_inserted)
  values (v_batch, p_series_id, 'weekly_refresh', coalesce(jsonb_array_length(p_rows), 0), 0);

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_date := (v_row->>'date')::date;
    v_kind := coalesce(v_row->>'kind', 'value');
    v_val := case when v_row->>'value_percent' is null then null else (v_row->>'value_percent')::numeric(9,4) end;
    select * into v_existing from public.ii_risk_free_observations where series_id = p_series_id and observation_date = v_date;
    if found then
      if v_existing.kind is not distinct from v_kind and v_existing.value_percent is not distinct from v_val then
        v_identical := v_identical + 1;
      else
        insert into public.ii_risk_free_review_items (series_id, observation_date, reasons, candidate, evidence, batch_id)
        values (p_series_id, v_date, array['conflicts_with_stored_value'], v_row, jsonb_build_object('stored', to_jsonb(v_existing)), v_batch)
        on conflict do nothing;
        v_queued := v_queued + 1;
      end if;
    else
      insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, extraction, batch_id)
      values (p_series_id, v_date, v_kind, v_val, nullif(v_row->>'gap_reason', ''), v_row->>'source_document', nullif(v_row->>'source_url', ''),
              (v_row->>'retrieved_on')::date, nullif(v_row->>'notes', ''), 'weekly_refresh_job', v_row->'extraction', v_batch);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  for v_rev in select * from jsonb_array_elements(coalesce(p_review_items, '[]'::jsonb)) loop
    insert into public.ii_risk_free_review_items (series_id, observation_date, reasons, candidate, evidence, batch_id)
    values (p_series_id, nullif(v_rev->>'observation_date', '')::date,
            coalesce(array(select jsonb_array_elements_text(v_rev->'reasons')), '{}'), v_rev->'candidate', v_rev->'evidence', v_batch)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_queued := v_queued + v_n;
  end loop;

  if p_verified_through is not null then
    update public.ii_risk_free_series
       set verified_through_date = greatest(coalesce(verified_through_date, p_verified_through), p_verified_through), updated_at = now()
     where series_id = p_series_id;
  end if;
  return jsonb_build_object('batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical, 'queued', v_queued);
end $fn$;
revoke all on function record_risk_free_refresh_results(text, jsonb, jsonb, date) from public, anon, authenticated;
grant execute on function record_risk_free_refresh_results(text, jsonb, jsonb, date) to service_role;

