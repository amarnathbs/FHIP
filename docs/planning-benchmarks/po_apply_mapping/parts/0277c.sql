-- PART C starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 4. Maintaining the mapping without SQL (the existing activate permission, audited)
-- ===========================================================================
-- Live figures a dataset and metric pair holds, by kind of file. Observed values are tied to the dataset. Planning bands
-- have no dataset column, so the bands of the metric that cite the dataset source, or cite no source, are counted.
create or replace function pb_live_figures(p_dataset uuid, p_metric uuid, p_kind text) returns integer
language sql stable security definer set search_path = '' as $fn$
  select case when p_kind = 'values' then
           (select count(*)::integer from public.benchmark_values v
             where v.dataset_id = p_dataset and v.metric_definition_id = p_metric and (v.effective_to is null or v.effective_to > current_date))
         else
           (select count(*)::integer from public.benchmark_target_ranges t
             where t.metric_definition_id = p_metric and (t.effective_to is null or t.effective_to > current_date)
               and (t.benchmark_source_id is null or t.benchmark_source_id = (select d.benchmark_source_id from public.benchmark_datasets d where d.id = p_dataset)))
         end;
$fn$;

-- Staged batches that use the pair and are still waiting (they would be refused at Activate once the pair is gone).
create or replace function pb_staged_batches_using(p_dataset uuid, p_metric uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select count(distinct b.id)::integer
    from public.benchmark_upload_batches b
    join public.benchmark_upload_rows r on r.batch_id = b.id
   where b.dataset_id = p_dataset and b.status = 'staged' and b.expires_at > now()
     and b.kind in ('values', 'target_ranges')
     and (r.payload ->> 'metric_definition_id')::uuid = p_metric;
$fn$;
revoke all on function pb_live_figures(uuid, uuid, text), pb_staged_batches_using(uuid, uuid) from public, anon, authenticated;

-- Add a metric to a dataset, or change which kinds of file it applies to.
create or replace function set_planning_benchmark_dataset_metric(p_dataset uuid, p_metric text, p_values boolean, p_ranges boolean, p_reason text, p_confirm_live boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  v_values boolean := coalesce(p_values, false);
  v_ranges boolean := coalesce(p_ranges, false);
  d record;
  m record;
  cur record;
  v_live integer := 0;
  v_staged integer := 0;
  v_action text;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: a reason of at least 3 characters is required';
  end if;
  if not (v_values or v_ranges) then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: choose at least one kind of file. To take a metric away use the remove action';
  end if;
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that dataset does not exist';
  end if;
  select * into m from public.benchmark_metric_definitions where metric_code = p_metric;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not registered. A metric cannot be created here';
  end if;
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_dataset_metric'));
  select * into cur from public.benchmark_dataset_metrics where dataset_id = d.id and metric_definition_id = m.id for update;
  if not found then
    insert into public.benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values, applies_to_target_ranges, evidence_note, created_by, updated_by)
    values (d.id, m.id, v_values, v_ranges, 'Added on the Upload tab: ' || v_reason, v_uid, v_uid);
    v_action := 'added';
  else
    if cur.applies_to_values = v_values and cur.applies_to_target_ranges = v_ranges then
      return jsonb_build_object('status', 'unchanged', 'dataset_id', d.id, 'metric_code', m.metric_code);
    end if;
    if cur.applies_to_values and not v_values then v_live := v_live + public.pb_live_figures(d.id, m.id, 'values'); end if;
    if cur.applies_to_target_ranges and not v_ranges then v_live := v_live + public.pb_live_figures(d.id, m.id, 'target_ranges'); end if;
    if v_live > 0 and not coalesce(p_confirm_live, false) then
      raise exception using errcode = '55000', message = 'PB_E_LIVE: ' || v_live::text || ' live figure(s) exist for this metric in this dataset and kind of file. Changing the mapping does not delete them, but a corrected upload of this metric would be refused. Tick the confirmation to continue';
    end if;
    v_staged := public.pb_staged_batches_using(d.id, m.id);
    update public.benchmark_dataset_metrics set applies_to_values = v_values, applies_to_target_ranges = v_ranges, updated_by = v_uid, updated_at = now() where id = cur.id;
    v_action := 'changed';
  end if;
  insert into public.benchmark_dataset_metric_events (dataset_id, metric_definition_id, dataset_name, dataset_version, metric_code, action, values_before, ranges_before, values_after, ranges_after, live_figures, live_confirmed, staged_batches, reason, actor_user_id)
  values (d.id, m.id, d.dataset_name, d.version, m.metric_code, v_action, cur.applies_to_values, cur.applies_to_target_ranges, v_values, v_ranges, v_live, coalesce(p_confirm_live, false), v_staged, v_reason, v_uid);
  return jsonb_build_object('status', v_action, 'dataset_id', d.id, 'metric_code', m.metric_code, 'applies_to_values', v_values, 'applies_to_target_ranges', v_ranges, 'live_figures', v_live, 'staged_batches', v_staged);
end;
$fn$;

-- Remove the mapping of a metric to a dataset. Live figures are never deleted. A pair that still has live figures needs the explicit confirmation.
create or replace function remove_planning_benchmark_dataset_metric(p_dataset uuid, p_metric text, p_reason text, p_confirm_live boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  d record;
  m record;
  cur record;
  v_live integer := 0;
  v_staged integer := 0;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: a reason of at least 3 characters is required';
  end if;
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that dataset does not exist';
  end if;
  select * into m from public.benchmark_metric_definitions where metric_code = p_metric;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not registered';
  end if;
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_dataset_metric'));
  select * into cur from public.benchmark_dataset_metrics where dataset_id = d.id and metric_definition_id = m.id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not mapped to that dataset';
  end if;
  if cur.applies_to_values then v_live := v_live + public.pb_live_figures(d.id, m.id, 'values'); end if;
  if cur.applies_to_target_ranges then v_live := v_live + public.pb_live_figures(d.id, m.id, 'target_ranges'); end if;
  if v_live > 0 and not coalesce(p_confirm_live, false) then
    raise exception using errcode = '55000', message = 'PB_E_LIVE: ' || v_live::text || ' live figure(s) exist for this metric in this dataset. Removing the mapping does not delete them, but a corrected upload of this metric would be refused. Tick the confirmation to continue';
  end if;
  v_staged := public.pb_staged_batches_using(d.id, m.id);
  delete from public.benchmark_dataset_metrics where id = cur.id;
  insert into public.benchmark_dataset_metric_events (dataset_id, metric_definition_id, dataset_name, dataset_version, metric_code, action, values_before, ranges_before, values_after, ranges_after, live_figures, live_confirmed, staged_batches, reason, actor_user_id)
  values (d.id, m.id, d.dataset_name, d.version, m.metric_code, 'removed', cur.applies_to_values, cur.applies_to_target_ranges, false, false, v_live, coalesce(p_confirm_live, false), v_staged, v_reason, v_uid);
  return jsonb_build_object('status', 'removed', 'dataset_id', d.id, 'metric_code', m.metric_code, 'live_figures', v_live, 'staged_batches', v_staged);
end;
$fn$;

revoke all on function set_planning_benchmark_dataset_metric(uuid, text, boolean, boolean, text, boolean), remove_planning_benchmark_dataset_metric(uuid, text, text, boolean) from public, anon;
grant execute on function set_planning_benchmark_dataset_metric(uuid, text, boolean, boolean, text, boolean), remove_planning_benchmark_dataset_metric(uuid, text, text, boolean) to authenticated;
