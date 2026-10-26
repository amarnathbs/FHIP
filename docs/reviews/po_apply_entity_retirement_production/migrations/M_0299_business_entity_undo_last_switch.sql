-- 0299 -- Undo the most recent itemised or net value only switch of a Company, Family Trust or HUF (Document2 (4) closure, entity mode switch Undo).
-- Additive only, forward only. Builds on 0297 (business_entity_switch_mode) and 0290 (entity_figure_mode_log). One new function, no table, no column.
--
-- WHY. Choosing itemised or net value only changes the number the entity is counted at: an itemised entity is counted at its derived net
-- (assets less liabilities), a net value only entity at its typed net. So the switch changes the canonical valuation source, it is not only a
-- way of showing the same figure. The SMSF already had a safe Undo (0290, smsf_entity_undo_last_switch). A Company, Family Trust or HUF had the
-- preview first switch and the history but no way back, only switching again and re-entering what was retired. This closes that gap with the
-- same behaviour as the SMSF.
--
-- WHAT IT DOES. business_entity_undo_last_switch(entity, confirm) undoes the NEWEST history row, and only when that row is a switch (to_itemised or
-- to_net_only). If anything else was written after it (an earlier undo, for example) it refuses, so a change is undone once and in order.
--   preview first   with confirm false NOTHING changes: the function does the work inside a sub transaction, reads the result and rolls it back.
--   to_itemised  ->  back to net value only: the typed net recorded by the switch is restored, every active line is ARCHIVED (is_active false, never
--                    deleted) so no value is counted twice, and the archived lines are written to the new history row.
--   to_net_only  ->  back to itemised: the lines that the switch archived are brought back (they were recorded in the history row), the typed net
--                    that stood at that moment is cleared and kept in the new history row.
--   either way the new history row (action undo, undoes_log_id) keeps what was retired, so nothing is lost and the either or rule always holds:
--   exactly one of the two ways is counted after the call.
-- Security definer with every query scoped to auth.uid(): another household entity answers as not found.

begin;

create or replace function business_entity_undo_last_switch(p_entity_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_e record;
  v_newest_id uuid;
  v_last record;
  v_net_before numeric;
  v_net_after numeric;
  v_log_id uuid;
  v_ids uuid[];
  v_snapshot jsonb;
  v_archive_assets integer := 0;
  v_archive_liabilities integer := 0;
  v_restore_assets integer := 0;
  v_restore_liabilities integer := 0;
  v_target_mode text;
begin
  if v_uid is null then
    raise exception 'entity: not authenticated' using errcode = '42501';
  end if;
  select * into v_e from business_entities where id = p_entity_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'entity: not found', errcode = 'P0002';
  end if;

  select l.id into v_newest_id from entity_figure_mode_log l
  where l.user_id = v_uid and l.entity_id = p_entity_id order by l.created_at desc, l.id desc limit 1;
  if v_newest_id is not null then
    select * into v_last from entity_figure_mode_log where id = v_newest_id;
  end if;
  if v_newest_id is null or v_last.action not in ('to_itemised', 'to_net_only') then
    raise exception 'entity: the most recent change to this entity cannot be undone here (nothing to undo, or something else was recorded after the last switch)' using errcode = '55000';
  end if;

  v_net_before := case when v_e.valuation_mode = 'detailed' then business_entity_derived_net(p_entity_id) else coalesce(v_e.summary_net_asset_value, 0) end;
  v_target_mode := case when v_last.action = 'to_itemised' then 'summary' else 'detailed' end;

  if v_last.action = 'to_itemised' then
    select count(*) into v_archive_assets from business_entity_assets a where a.business_entity_id = p_entity_id and a.is_active;
    select count(*) into v_archive_liabilities from business_entity_liabilities l where l.business_entity_id = p_entity_id and l.is_active;
  else
    select coalesce(count(*), 0) into v_restore_assets from jsonb_array_elements(coalesce(v_last.retired_representation -> 'assets', '[]'::jsonb));
    select coalesce(count(*), 0) into v_restore_liabilities from jsonb_array_elements(coalesce(v_last.retired_representation -> 'liabilities', '[]'::jsonb));
  end if;

  begin
    perform set_config('fhip.entity_mode_switch', 'certified', true);

    if v_last.action = 'to_itemised' then
      -- Back to net value only. What is counted now is kept in the history row, then archived, then the typed net is restored.
      v_snapshot := jsonb_build_object(
        'assets', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from business_entity_assets a where a.business_entity_id = p_entity_id and a.is_active),
        'liabilities', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from business_entity_liabilities l where l.business_entity_id = p_entity_id and l.is_active),
        'undid', v_last.action);
      update business_entity_assets set is_active = false, updated_at = now() where business_entity_id = p_entity_id and is_active;
      update business_entity_liabilities set is_active = false, updated_at = now() where business_entity_id = p_entity_id and is_active;
      update business_entities
      set valuation_mode = 'summary', summary_net_asset_value = (v_last.retired_representation ->> 'typed_net')::numeric, updated_at = now()
      where id = p_entity_id;
    else
      -- Back to itemised. The typed net standing now is kept in the history row and cleared, then the archived lines come back.
      v_snapshot := jsonb_build_object('typed_net', v_e.summary_net_asset_value, 'undid', v_last.action);
      update business_entities set valuation_mode = 'detailed', summary_net_asset_value = null, updated_at = now() where id = p_entity_id;
      select coalesce(array_agg((x ->> 'id')::uuid), '{}') into v_ids from jsonb_array_elements(coalesce(v_last.retired_representation -> 'assets', '[]'::jsonb)) x;
      update business_entity_assets set is_active = true, updated_at = now() where id = any (v_ids) and business_entity_id = p_entity_id;
      select coalesce(array_agg((x ->> 'id')::uuid), '{}') into v_ids from jsonb_array_elements(coalesce(v_last.retired_representation -> 'liabilities', '[]'::jsonb)) x;
      update business_entity_liabilities set is_active = true, updated_at = now() where id = any (v_ids) and business_entity_id = p_entity_id;
    end if;

    v_net_after := case when v_target_mode = 'detailed' then business_entity_derived_net(p_entity_id) else coalesce((select e.summary_net_asset_value from business_entities e where e.id = p_entity_id), 0) end;

    if not p_confirm then
      raise exception 'preview only' using errcode = 'FPRV1';
    end if;

    insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation, undoes_log_id)
    values (v_uid, v_e.entity_type, p_entity_id, 'undo', v_e.valuation_mode, v_target_mode, v_net_before, v_net_after,
            round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2), v_snapshot, v_last.id)
    returning id into v_log_id;
    perform set_config('fhip.entity_mode_switch', '', true);
  exception when sqlstate 'FPRV1' then
    return jsonb_build_object('status', 'preview', 'undoes', v_last.action, 'from_mode', v_e.valuation_mode, 'to_mode', v_target_mode,
                              'net_before', v_net_before, 'net_after', v_net_after,
                              'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2),
                              'will_archive', jsonb_build_object('assets', v_archive_assets, 'liabilities', v_archive_liabilities),
                              'will_restore', jsonb_build_object('assets', v_restore_assets, 'liabilities', v_restore_liabilities));
  end;

  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'undid', v_last.action, 'from_mode', v_e.valuation_mode, 'to_mode', v_target_mode,
                            'net_before', v_net_before, 'net_after', v_net_after,
                            'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
end;
$fn$;

revoke all on function business_entity_undo_last_switch(uuid, boolean) from public;
revoke all on function business_entity_undo_last_switch(uuid, boolean) from anon;
grant execute on function business_entity_undo_last_switch(uuid, boolean) to authenticated;

comment on function business_entity_undo_last_switch(uuid, boolean) is
  'Undoes the newest itemised or net value only switch of a Company, Family Trust or HUF (0299). Preview first (p_confirm false changes nothing and reports the net before and after), then one transaction: the current representation is archived and kept in the history row, the previous one is restored. Nothing is deleted.';

-- Rollback notes. Drop the function business_entity_undo_last_switch with its two arguments (uuid and boolean). Nothing else depends on it and no row is changed by
-- this migration. History rows already written with action undo stay valid because the action value was allowed since 0290.

commit;
