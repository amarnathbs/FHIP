-- Migration 0290 part 2 of 5: switch mode. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Switch (preview-first, atomic)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_entity_switch_mode(
  p_fund_id uuid,
  p_to_mode text,
  p_assets jsonb default '[]'::jsonb,
  p_liabilities jsonb default '[]'::jsonb,
  p_net numeric default null,
  p_net_date date default null,
  p_confirm boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_net_before numeric;
  v_net_after numeric;
  v_snapshot jsonb := '{}'::jsonb;
  v_retired_h uuid[];
  v_retired_l uuid[];
  v_new_h uuid[] := '{}';
  v_new_l uuid[] := '{}';
  v_item jsonb;
  v_id uuid;
  v_log_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' not found or not visible to the current user', errcode = 'P0002';
  end if;
  if p_to_mode not in ('detailed', 'summary') then
    raise exception 'smsf: p_to_mode must be detailed (itemised) or summary (net value only)' using errcode = '22023';
  end if;
  if v_fund.mode = p_to_mode then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' is already recorded that way', errcode = '55000';
  end if;
  if p_to_mode = 'detailed' and jsonb_array_length(coalesce(p_assets, '[]'::jsonb)) = 0 and jsonb_array_length(coalesce(p_liabilities, '[]'::jsonb)) = 0 then
    raise exception 'smsf: enter at least one asset or liability to record the fund as itemised' using errcode = '22023';
  end if;
  if p_to_mode = 'summary' and (p_net is null or p_net < 0) then
    raise exception 'smsf: enter the net value (zero or more) to record the fund as a net value only' using errcode = '22023';
  end if;

  v_net_before := smsf_fund_counted_net(p_fund_id);

  begin
    perform set_config('fhip.entity_mode_switch', 'certified', true);

    if p_to_mode = 'detailed' then
      -- Retire any stray active lines first (a legacy net-value fund that still carries preview lines), then flip, then insert.
      select coalesce(array_agg(h.id), '{}') into v_retired_h from smsf_holdings h where h.smsf_fund_id = p_fund_id and h.is_active;
      select coalesce(array_agg(l.id), '{}') into v_retired_l from smsf_liabilities l where l.smsf_fund_id = p_fund_id and l.is_active;
      update smsf_holdings set is_active = false, updated_at = now() where id = any (v_retired_h);
      update smsf_liabilities set is_active = false, updated_at = now() where id = any (v_retired_l);

      v_snapshot := jsonb_build_object('typed_net', v_fund.summary_balance, 'typed_net_date', v_fund.summary_balance_date,
                                       'retired_holding_ids', to_jsonb(v_retired_h), 'retired_liability_ids', to_jsonb(v_retired_l));

      update smsf_funds
      set mode = 'detailed', summary_balance = null, summary_balance_date = null, activated_detailed_at = now(), updated_at = now()
      where id = p_fund_id;

      for v_item in select * from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) loop
        insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code, country_code, notes)
        values (v_uid, p_fund_id, v_item->>'holding_class', v_item->>'holding_type', v_item->>'holding_name',
                (v_item->>'value')::numeric, coalesce(v_item->>'currency_code', v_fund.currency_code), nullif(v_item->>'country_code', ''), nullif(v_item->>'notes', ''))
        returning id into v_id;
        v_new_h := v_new_h || v_id;
      end loop;
      for v_item in select * from jsonb_array_elements(coalesce(p_liabilities, '[]'::jsonb)) loop
        insert into smsf_liabilities (user_id, smsf_fund_id, liability_name, liability_type, lender, balance, interest_rate, monthly_repayment, currency_code, country_code, notes)
        values (v_uid, p_fund_id, v_item->>'liability_name', coalesce(v_item->>'liability_type', 'other'), nullif(v_item->>'lender', ''),
                (v_item->>'balance')::numeric, nullif(v_item->>'interest_rate', '')::numeric, nullif(v_item->>'monthly_repayment', '')::numeric,
                coalesce(v_item->>'currency_code', v_fund.currency_code), nullif(v_item->>'country_code', ''), nullif(v_item->>'notes', ''))
        returning id into v_id;
        v_new_l := v_new_l || v_id;
      end loop;
      v_snapshot := v_snapshot || jsonb_build_object('inserted_holding_ids', to_jsonb(v_new_h), 'inserted_liability_ids', to_jsonb(v_new_l));
      perform smsf_recompute_fund(p_fund_id);
    else
      select coalesce(array_agg(h.id), '{}') into v_retired_h from smsf_holdings h where h.smsf_fund_id = p_fund_id and h.is_active;
      select coalesce(array_agg(l.id), '{}') into v_retired_l from smsf_liabilities l where l.smsf_fund_id = p_fund_id and l.is_active;
      v_snapshot := jsonb_build_object('detailed_net', v_fund.detailed_net_value,
                                       'retired_holding_ids', to_jsonb(v_retired_h), 'retired_liability_ids', to_jsonb(v_retired_l));
      update smsf_holdings set is_active = false, updated_at = now() where id = any (v_retired_h);
      update smsf_liabilities set is_active = false, updated_at = now() where id = any (v_retired_l);
      -- One update: the existing summary-sync trigger (0084/0090) writes the fund row balance inside its certified bracket.
      update smsf_funds
      set mode = 'summary', summary_balance = p_net, summary_balance_date = p_net_date, detailed_net_value = null, updated_at = now()
      where id = p_fund_id;
    end if;

    v_net_after := smsf_fund_counted_net(p_fund_id);

    if not p_confirm then
      raise exception 'preview only' using errcode = 'FPRV1';
    end if;

    insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation)
    values (v_uid, 'smsf', p_fund_id, case when p_to_mode = 'detailed' then 'to_itemised' else 'to_net_only' end, v_fund.mode, p_to_mode,
            v_net_before, v_net_after, round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2), v_snapshot)
    returning id into v_log_id;
    perform set_config('fhip.entity_mode_switch', '', true);
  exception when sqlstate 'FPRV1' then
    return jsonb_build_object('status', 'preview', 'from_mode', v_fund.mode, 'to_mode', p_to_mode,
                              'net_before', v_net_before, 'net_after', v_net_after,
                              'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2),
                              'retired', v_snapshot);
  end;

  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'from_mode', v_fund.mode, 'to_mode', p_to_mode,
                            'net_before', v_net_before, 'net_after', v_net_after,
                            'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
end;
$fn$;

comment on function smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean) is
  'Atomic, preview-first change of how an SMSF fund is recorded (0290). p_to_mode detailed = itemised: p_assets (holding_class, holding_type, holding_name, value, currency_code, ...) and p_liabilities (liability_name, balance, ...) are inserted, the typed net is retired to entity_figure_mode_log and cleared. p_to_mode summary = net value only: p_net is typed, every active line is archived. p_confirm false changes nothing and returns net_before/net_after/variance. Security definer with every query scoped to auth.uid().';

commit;
