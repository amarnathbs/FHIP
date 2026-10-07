-- ---------------------------------------------------------------------------
-- PART E starts here: resolve, correct and set-state functions and the job-control rows
-- ---------------------------------------------------------------------------
-- 8. resolve_risk_free_review_item
-- ---------------------------------------------------------------------------
create or replace function resolve_risk_free_review_item(p_item_id uuid, p_decision text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_item record;
  v_c jsonb;
  v_inserted boolean := false;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free review: not authorised' using errcode = '42501';
  end if;
  if p_decision not in ('accept', 'reject') then
    raise exception 'risk-free review: decision must be accept or reject' using errcode = '22023';
  end if;
  if p_note is null or length(trim(p_note)) < 20 then
    raise exception 'risk-free review: a note of at least 20 characters is required' using errcode = '22023';
  end if;
  select * into v_item from public.ii_risk_free_review_items where id = p_item_id for update;
  if not found or v_item.status <> 'open' then
    raise exception 'risk-free review: item not found or already resolved' using errcode = '22023';
  end if;
  if p_decision = 'accept' then
    v_c := v_item.candidate;
    if v_c is null or v_c->>'date' is null then
      raise exception 'risk-free review: this item has no publishable candidate, reject it and upload the value' using errcode = '22023';
    end if;
    if exists (select 1 from public.ii_risk_free_observations where series_id = v_item.series_id and observation_date = (v_c->>'date')::date) then
      raise exception 'risk-free review: a value already exists for that date, use a correction' using errcode = '22023';
    end if;
    insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, extraction)
    values (v_item.series_id, (v_c->>'date')::date, coalesce(v_c->>'kind', 'value'),
            case when v_c->>'value_percent' is null then null else (v_c->>'value_percent')::numeric(9,4) end,
            nullif(v_c->>'gap_reason', ''), v_c->>'source_document', nullif(v_c->>'source_url', ''), (v_c->>'retrieved_on')::date,
            left('Accepted via the review queue: ' || p_note, 500), 'admin_upload', v_c->'extraction');
    v_inserted := true;
  end if;
  update public.ii_risk_free_review_items
     set status = case when p_decision = 'accept' then 'accepted' else 'rejected' end,
         resolved_at = now(), resolved_by = v_uid, resolution_note = left(p_note, 500)
   where id = p_item_id;
  return jsonb_build_object('item_id', p_item_id, 'decision', p_decision, 'observation_inserted', v_inserted);
end $fn$;
revoke all on function resolve_risk_free_review_item(uuid, text, text) from public, anon;
grant execute on function resolve_risk_free_review_item(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. correct_risk_free_observation -- the ONLY way a published value changes
-- ---------------------------------------------------------------------------
create or replace function correct_risk_free_observation(p_series_id text, p_date date, p_new_value numeric, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_obs record;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free correction: not authorised' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'risk-free correction: a reason of at least 20 characters is required' using errcode = '22023';
  end if;
  if p_new_value is null or p_new_value < 0 or p_new_value > 100 then
    raise exception 'risk-free correction: the value must be a percent between 0 and 100' using errcode = '22023';
  end if;
  select * into v_obs from public.ii_risk_free_observations where series_id = p_series_id and observation_date = p_date and kind = 'value' for update;
  if not found then
    raise exception 'risk-free correction: no published value for that series and date' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_corrections (observation_id, series_id, observation_date, previous_value_percent, new_value_percent, reason, actor_user_id)
  values (v_obs.id, p_series_id, p_date, v_obs.value_percent, round(p_new_value, 4), p_reason, v_uid);
  perform set_config('fhip.risk_free_correction', 'on', true);
  update public.ii_risk_free_observations set value_percent = round(p_new_value, 4) where id = v_obs.id;
  perform set_config('fhip.risk_free_correction', 'off', true);
  return jsonb_build_object('observation_id', v_obs.id, 'previous', v_obs.value_percent, 'new', round(p_new_value, 4));
end $fn$;
revoke all on function correct_risk_free_observation(text, date, numeric, text) from public, anon;
grant execute on function correct_risk_free_observation(text, date, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. set_risk_free_series_state -- enabled flag and terms status, audited
-- ---------------------------------------------------------------------------
create or replace function set_risk_free_series_state(p_series_id text, p_enabled boolean, p_terms_status text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_s record;
begin
  if v_uid is null or not public.is_risk_free_series_switch_admin() then
    raise exception 'risk-free series state: not authorised' using errcode = '42501';
  end if;
  if p_enabled is null or p_terms_status not in ('po_accepted_2026-10-03', 'confirmed_in_writing', 'pending_confirmation', 'declined') then
    raise exception 'risk-free series state: invalid enabled flag or terms status' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'risk-free series state: a reason of at least 20 characters is required' using errcode = '22023';
  end if;
  select * into v_s from public.ii_risk_free_series where series_id = p_series_id for update;
  if not found then
    raise exception 'risk-free series state: unknown series' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
  values (p_series_id, v_s.enabled, p_enabled, v_s.terms_review_status, p_terms_status, p_reason, v_uid);
  update public.ii_risk_free_series set enabled = p_enabled, terms_review_status = p_terms_status, updated_at = now() where series_id = p_series_id;
  return jsonb_build_object('series_id', p_series_id, 'enabled', p_enabled, 'terms_review_status', p_terms_status);
end $fn$;
revoke all on function set_risk_free_series_state(text, boolean, text, text) from public, anon;
grant execute on function set_risk_free_series_state(text, boolean, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. Job-control rows: ALL SHIPPED DISABLED (the kill switches are the existing mechanism)
-- ---------------------------------------------------------------------------
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_risk_free_weekly_refresh', false, 'Ships DISABLED (PO decision 2026-10-03: automated weekly RBI read, default OFF with dry run). Enabling is a deliberate human step after a DEV dry run.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_fund_analytics', false, 'Ships DISABLED: the Fund analytics report feature switch. Enabling is a deliberate human step after Stage 3 DEV certification.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_fund_analytics');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_trigger_planner', false, 'Ships DISABLED: when off the existing user-scoped NAV fetch runs exactly as before, when on the required-window planner sizes the fetch.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_trigger_planner');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_correction_worker', false, 'Ships DISABLED: processes ii_reference_corrections events for fund analytics cache invalidation. Enabling is a deliberate human step.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_correction_worker');

-- ROLLBACK: drop the functions, tables (in reverse dependency order), the two admin_users columns and the four
-- job-control rows. Nothing else depends on them. No NAV data is touched by this migration.
