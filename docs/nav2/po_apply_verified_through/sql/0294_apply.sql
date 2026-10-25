-- 0294 -- Risk-free rate data: a governed way to confirm that a policy-change series (the RBI repo rate) is still current, and the
-- upload function made honest about the verified-through date.
--
-- Found on 19-10-2026 (Product Owner, production): the verified-through date of the repo series stayed at 02-10-2026 after the rate file was
-- submitted again with 19-10-2026 typed in. The upload path moves that date forward in every case the repository can reproduce
-- (the same file again, or a new file whose rows are all identical), so the cause is not a failed update. What the path DID get wrong:
--   1. the future-date rule used the server calendar day (UTC), so an operator in India or Australia early in their day typing today
--      was refused as a date in the future, and nothing told them what the server day was
--   2. the answer to the operator said that rows were written, never whether the date moved, so a refused or unchanged date looked like success
--   3. a date typed for a weekly series (the 91-day T-bill) was stored although it means nothing there
--   4. confirming that no rate change happened required re-submitting a data file and ticking a data attestation, which is the wrong act
--
-- What this migration does (forward-only, additive, idempotent: every statement can be run again, no table or constraint is touched):
--   a. risk_free_today(): the calendar day in India (the Reserve Bank of India calendar). Used wherever a date may not be in the future.
--   b. confirm_risk_free_verified_through(series, date, reason): the dedicated control. Policy-change series only, the same upload capability
--      as an upload, a reason of at least 20 characters, never earlier than the last published rate, never later than today in India,
--      strictly later than the date already recorded (an equal or earlier date is refused with a message, never a silent no-op).
--      It changes no rate. It writes one row to the append-only state log (who, when, the old and new date, the reason).
--   c. commit_risk_free_upload(): the same function as in 0260, replaced by create or replace with exactly three changes:
--      the future-date rule uses risk_free_today(), a weekly series ignores a verified-through date, and the answer says whether the date
--      moved (verified_through_moved) and what it is now (verified_through). Every other line is as in 0260.
--
-- HAND-OVER ARTEFACT: not applied anywhere. DEV first. The steps and checks are in docs/nav2/po_apply_verified_through/README.md.
-- Migration number freshness: scanned 19-10-2026 across every branch and worktree, 0286, 0289, 0290, 0292 and 0293 are taken by other
-- branches and 0285 is the highest on main, so 0294 is free. The checker scripts cannot see unmerged branches, so re-check at merge.
--
-- ADMIN ARCHITECTURE STANDARD (docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md), applied:
--   section 2  no new capability: confirming a series is an upload duty, so it uses can_upload_risk_free_data (is_risk_free_data_admin).
--              The switch capability is not enough and neither is admin_users membership.
--   section 4  database layer: the function is SECURITY DEFINER and checks auth.uid() and the predicate INSIDE.
--   section 6  fixed search_path, schema-qualified references, explicit return type, execute revoked for public and anon.
--   section 8  an unauthorised caller gets an exception (42501), never an empty result. A refused confirmation is an exception (22023).
--   section 9  global reference data only, no user data.

-- ---------------------------------------------------------------------------
-- 1. The calendar day in India
-- ---------------------------------------------------------------------------
create or replace function risk_free_today() returns date
language sql stable set search_path = public as $fn$
  select (now() at time zone 'Asia/Kolkata')::date;
$fn$;
revoke all on function risk_free_today() from public, anon;
grant execute on function risk_free_today() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. confirm_risk_free_verified_through -- the governed confirmation
-- ---------------------------------------------------------------------------
create or replace function confirm_risk_free_verified_through(p_series_id text, p_verified_through date, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_s record;
  v_today date := public.risk_free_today();
  v_last date;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free confirmation: not authorised' using errcode = '42501';
  end if;
  if p_series_id is null or p_verified_through is null then
    raise exception 'risk-free confirmation: the series and the date are required' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'risk-free confirmation: a reason of at least 20 characters is required' using errcode = '22023';
  end if;
  select * into v_s from public.ii_risk_free_series where series_id = p_series_id for update;
  if not found then
    raise exception 'risk-free confirmation: unknown series' using errcode = '22023';
  end if;
  if v_s.cadence <> 'policy_change' then
    raise exception 'risk-free confirmation: only a policy-change series is confirmed this way, a weekly series is kept current by its auction rows' using errcode = '22023';
  end if;
  if p_verified_through > v_today then
    raise exception using message = 'risk-free confirmation: the date cannot be in the future, today in India is ' || to_char(v_today, 'DD-MM-YYYY'), errcode = '22023';
  end if;
  select max(o.observation_date) into v_last from public.ii_risk_free_observations o where o.series_id = p_series_id and o.kind = 'value';
  if v_last is null then
    raise exception 'risk-free confirmation: this series has no published rate yet, load its rates first' using errcode = '22023';
  end if;
  if p_verified_through < v_last then
    raise exception using message = 'risk-free confirmation: the date is earlier than the last published rate (' || to_char(v_last, 'DD-MM-YYYY') || ')', errcode = '22023';
  end if;
  if v_s.verified_through_date is not null and p_verified_through <= v_s.verified_through_date then
    raise exception using message = 'risk-free confirmation: the series is already confirmed through ' || to_char(v_s.verified_through_date, 'DD-MM-YYYY') || ', a confirmation must be later than that', errcode = '22023';
  end if;
  insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
  values (p_series_id, v_s.enabled, v_s.enabled, v_s.terms_review_status, v_s.terms_review_status,
          'Confirmed still current through ' || to_char(p_verified_through, 'DD-MM-YYYY')
            || case when v_s.verified_through_date is null then ' (not confirmed before)' else ' (was ' || to_char(v_s.verified_through_date, 'DD-MM-YYYY') || ')' end
            || '. Reason: ' || left(trim(p_reason), 400),
          v_uid);
  update public.ii_risk_free_series set verified_through_date = p_verified_through, updated_at = now() where series_id = p_series_id;
  return jsonb_build_object('series_id', p_series_id, 'previous', to_char(v_s.verified_through_date, 'YYYY-MM-DD'), 'new', to_char(p_verified_through, 'YYYY-MM-DD'));
end $fn$;
revoke all on function confirm_risk_free_verified_through(text, date, text) from public, anon;
grant execute on function confirm_risk_free_verified_through(text, date, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. commit_risk_free_upload -- as in 0260 with the three changes named in the header
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
  v_cadence text;
  v_through date;
  v_before date;
  v_moved boolean := false;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free upload: not authorised' using errcode = '42501';
  end if;
  select s.cadence into v_cadence from public.ii_risk_free_series s where s.series_id = p_series_id;
  if not found then
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
  if p_verified_through is not null and p_verified_through > public.risk_free_today() then
    raise exception 'risk-free upload: the verified-through date cannot be in the future' using errcode = '22023';
  end if;
  -- A verified-through date means something only for a policy-change series. For a weekly series it is dropped here and never stored.
  v_through := case when v_cadence = 'policy_change' then p_verified_through else null end;

  select * into v_existing from public.ii_risk_free_batches
   where series_id = p_series_id and file_sha256 = p_file_sha256 and source_kind = 'admin_csv';
  if found then
    -- The same file again. Its rows are already in, only a NEW verified_through confirmation (the day a policy-change
    -- series was last confirmed complete) is applied, and it is recorded in the append-only state log (who, when, to what).
    if v_through is not null
       and exists (select 1 from public.ii_risk_free_series x where x.series_id = p_series_id and (x.verified_through_date is null or x.verified_through_date < v_through)) then
      -- Only a date that moves the confirmation FORWARD is applied and logged, an earlier or equal date is a no-op.
      update public.ii_risk_free_series
         set verified_through_date = v_through, updated_at = now()
       where series_id = p_series_id;
      v_moved := true;
      insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
      select s.series_id, s.enabled, s.enabled, s.terms_review_status, s.terms_review_status,
             'Verified-through date confirmed through ' || to_char(v_through, 'DD-MM-YYYY') || ' (re-submitted file).', v_uid
        from public.ii_risk_free_series s where s.series_id = p_series_id;
    end if;
    return jsonb_build_object('already_committed', true, 'batch_id', v_existing.id, 'inserted', v_existing.rows_inserted, 'identical', v_existing.rows_identical_skipped, 'verified_through_recorded', p_verified_through is not null,
      'verified_through_moved', v_moved, 'verified_through', (select to_char(x.verified_through_date, 'YYYY-MM-DD') from public.ii_risk_free_series x where x.series_id = p_series_id));
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

  if v_through is not null then
    select x.verified_through_date into v_before from public.ii_risk_free_series x where x.series_id = p_series_id;
    update public.ii_risk_free_series
       set verified_through_date = greatest(coalesce(verified_through_date, v_through), v_through), updated_at = now()
     where series_id = p_series_id;
    v_moved := v_before is null or v_before < v_through;
  end if;
  return jsonb_build_object('already_committed', false, 'batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical,
    'verified_through_moved', v_moved, 'verified_through', (select to_char(x.verified_through_date, 'YYYY-MM-DD') from public.ii_risk_free_series x where x.series_id = p_series_id));
end $fn$;
revoke all on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) from public, anon;
grant execute on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) to authenticated, service_role;

-- ROLLBACK: apply part d of 0260 again (docs/nav2/po_apply_production/sql/parts/0260d.sql, it restores commit_risk_free_upload and
-- record_risk_free_refresh_results exactly as in 0260), then drop confirm_risk_free_verified_through and risk_free_today. No table, row or
-- column is touched by this migration, so a rollback loses no data. A state log row written by a confirmation stays (it is append-only).
