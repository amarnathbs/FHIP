-- Migration 0290 part 3 of 5: undo and retire typed net. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Undo the most recent switch
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_entity_undo_last_switch(p_fund_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_last record;
  v_newest_id uuid;
  v_net_before numeric;
  v_net_after numeric;
  v_log_id uuid;
  v_ids uuid[];
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' not found or not visible to the current user', errcode = 'P0002';
  end if;

  select l.id into v_newest_id from entity_figure_mode_log l
  where l.user_id = v_uid and l.entity_id = p_fund_id order by l.created_at desc, l.id desc limit 1;
  select * into v_last from entity_figure_mode_log where id = v_newest_id;
  if v_newest_id is null or v_last.action not in ('to_itemised', 'to_net_only') then
    raise exception 'smsf: the most recent change to this fund cannot be undone here (nothing to undo, or something else was changed after the last switch)' using errcode = '55000';
  end if;

  v_net_before := smsf_fund_counted_net(p_fund_id);

  begin
    perform set_config('fhip.entity_mode_switch', 'certified', true);

    if v_last.action = 'to_itemised' then
      -- Back to the net value only: archive what the switch inserted, restore the typed net, bring back any lines it retired.
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(v_last.retired_representation->'inserted_holding_ids', '[]'::jsonb)) x;
      update smsf_holdings set is_active = false, updated_at = now() where id = any (v_ids);
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(v_last.retired_representation->'inserted_liability_ids', '[]'::jsonb)) x;
      update smsf_liabilities set is_active = false, updated_at = now() where id = any (v_ids);
      update smsf_funds
      set mode = 'summary', summary_balance = (v_last.retired_representation->>'typed_net')::numeric,
          summary_balance_date = nullif(v_last.retired_representation->>'typed_net_date', '')::date, detailed_net_value = null, updated_at = now()
      where id = p_fund_id;
      -- The retired legacy lines are restored only while the fund is itemised, so they stay archived here (a net-only fund holds none).
    else
      -- Back to itemised: flip first, then bring the archived lines back, then recompute.
      update smsf_funds set mode = 'detailed', summary_balance = null, summary_balance_date = null, activated_detailed_at = now(), updated_at = now() where id = p_fund_id;
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(v_last.retired_representation->'retired_holding_ids', '[]'::jsonb)) x;
      update smsf_holdings set is_active = true, updated_at = now() where id = any (v_ids);
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(v_last.retired_representation->'retired_liability_ids', '[]'::jsonb)) x;
      update smsf_liabilities set is_active = true, updated_at = now() where id = any (v_ids);
      perform smsf_recompute_fund(p_fund_id);
    end if;

    v_net_after := smsf_fund_counted_net(p_fund_id);

    if not p_confirm then
      raise exception 'preview only' using errcode = 'FPRV1';
    end if;

    insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation, undoes_log_id)
    values (v_uid, 'smsf', p_fund_id, 'undo', v_fund.mode, case when v_last.action = 'to_itemised' then 'summary' else 'detailed' end,
            v_net_before, v_net_after, round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2), jsonb_build_object('undid', v_last.action), v_last.id)
    returning id into v_log_id;
    perform set_config('fhip.entity_mode_switch', '', true);
  exception when sqlstate 'FPRV1' then
    return jsonb_build_object('status', 'preview', 'undoes', v_last.action, 'net_before', v_net_before, 'net_after', v_net_after,
                              'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
  end;

  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'undid', v_last.action, 'net_before', v_net_before, 'net_after', v_net_after,
                            'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
end;
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Retire a stale typed net on an itemised fund (the legacy shape), keeping it in the history
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_entity_retire_typed_net(p_fund_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_net numeric;
  v_log_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' not found or not visible to the current user', errcode = 'P0002';
  end if;
  if v_fund.mode <> 'detailed' or v_fund.summary_balance is null then
    raise exception 'smsf: nothing to retire (the fund is not itemised, or has no typed net value)' using errcode = '55000';
  end if;
  v_net := smsf_fund_counted_net(p_fund_id);

  if not p_confirm then
    return jsonb_build_object('status', 'preview', 'typed_net', v_fund.summary_balance, 'counted_net', v_net, 'variance', 0);
  end if;

  perform set_config('fhip.entity_mode_switch', 'certified', true);
  update smsf_funds set summary_balance = null, summary_balance_date = null, updated_at = now() where id = p_fund_id;
  perform set_config('fhip.entity_mode_switch', '', true);
  insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation)
  values (v_uid, 'smsf', p_fund_id, 'retire_typed_net', 'detailed', 'detailed', v_net, v_net, 0,
          jsonb_build_object('typed_net', v_fund.summary_balance, 'typed_net_date', v_fund.summary_balance_date))
  returning id into v_log_id;
  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'typed_net', v_fund.summary_balance, 'counted_net', v_net, 'variance', 0);
end;
$fn$;

commit;
