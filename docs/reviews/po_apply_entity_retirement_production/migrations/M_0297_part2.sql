-- Migration 0297 part 2 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The entity net in the entity currency, derived out of the active lines, never typed
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function business_entity_derived_net(p_entity_id uuid) returns numeric as $fn$
declare
  fx numeric;
  v_currency text;
  v_assets numeric;
  v_liabs numeric;
begin
  select assumption_value into fx
  from forecast_global_assumptions
  where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true
  limit 1;
  fx := coalesce(fx, 56.0);
  select e.currency_code into v_currency from business_entities e where e.id = p_entity_id;
  select coalesce(sum(case when a.currency_code = v_currency then a.value
                           when a.currency_code = 'INR' and v_currency = 'AUD' then a.value / fx
                           when a.currency_code = 'AUD' and v_currency = 'INR' then a.value * fx
                           else a.value end), 0)
    into v_assets from business_entity_assets a where a.business_entity_id = p_entity_id and a.is_active;
  select coalesce(sum(case when l.currency_code = v_currency then l.value
                           when l.currency_code = 'INR' and v_currency = 'AUD' then l.value / fx
                           when l.currency_code = 'AUD' and v_currency = 'INR' then l.value * fx
                           else l.value end), 0)
    into v_liabs from business_entity_liabilities l where l.business_entity_id = p_entity_id and l.is_active;
  return v_assets - v_liabs;
end;
$fn$ language plpgsql stable;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Switch (preview first, atomic, history kept)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function business_entity_switch_mode(
  p_entity_id uuid,
  p_to_mode text,
  p_assets jsonb default '[]'::jsonb,
  p_liabilities jsonb default '[]'::jsonb,
  p_net numeric default null,
  p_confirm boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_e record;
  v_net_before numeric;
  v_net_after numeric;
  v_fx numeric;
  v_snapshot jsonb := '{}'::jsonb;
  v_item jsonb;
  v_retired_a uuid[];
  v_retired_l uuid[];
begin
  if v_uid is null then
    raise exception 'entity: not authenticated' using errcode = '42501';
  end if;
  select * into v_e from business_entities where id = p_entity_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'entity: not found', errcode = 'P0002';
  end if;
  if p_to_mode not in ('detailed', 'summary') then
    raise exception 'entity: the new way must be detailed (itemised) or summary (net value only)' using errcode = '22023';
  end if;
  if v_e.valuation_mode = p_to_mode then
    raise exception using message = 'entity: this entity is already recorded that way', errcode = '55000';
  end if;
  if p_to_mode = 'detailed' and jsonb_array_length(coalesce(p_assets, '[]'::jsonb)) + jsonb_array_length(coalesce(p_liabilities, '[]'::jsonb)) = 0 then
    raise exception 'entity: enter at least one asset or liability to record the entity as itemised' using errcode = '22023';
  end if;
  if p_to_mode = 'summary' and (p_net is null) then
    raise exception 'entity: enter the net value to record the entity as a net value only' using errcode = '22023';
  end if;

  select assumption_value into v_fx from forecast_global_assumptions
    where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true limit 1;
  v_fx := coalesce(v_fx, 56.0);

  v_net_before := case when v_e.valuation_mode = 'detailed' then business_entity_derived_net(p_entity_id) else coalesce(v_e.summary_net_asset_value, 0) end;

  if p_to_mode = 'detailed' then
    v_net_after := coalesce((
      select sum(case when (x ->> 'currency_code') = v_e.currency_code then (x ->> 'value')::numeric
                      when (x ->> 'currency_code') = 'INR' and v_e.currency_code = 'AUD' then (x ->> 'value')::numeric / v_fx
                      when (x ->> 'currency_code') = 'AUD' and v_e.currency_code = 'INR' then (x ->> 'value')::numeric * v_fx
                      else (x ->> 'value')::numeric end)
      from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) x), 0)
      - coalesce((
      select sum(case when (x ->> 'currency_code') = v_e.currency_code then (x ->> 'value')::numeric
                      when (x ->> 'currency_code') = 'INR' and v_e.currency_code = 'AUD' then (x ->> 'value')::numeric / v_fx
                      when (x ->> 'currency_code') = 'AUD' and v_e.currency_code = 'INR' then (x ->> 'value')::numeric * v_fx
                      else (x ->> 'value')::numeric end)
      from jsonb_array_elements(coalesce(p_liabilities, '[]'::jsonb)) x), 0);
  else
    v_net_after := p_net;
  end if;

  if not p_confirm then
    return jsonb_build_object('status', 'preview', 'from_mode', v_e.valuation_mode, 'to_mode', p_to_mode,
                              'net_before', v_net_before, 'net_after', v_net_after, 'variance', round(v_net_after - v_net_before, 2));
  end if;

  perform set_config('fhip.entity_mode_switch', 'certified', true);

  if p_to_mode = 'detailed' then
    v_snapshot := jsonb_build_object('typed_net', v_e.summary_net_asset_value);
    select coalesce(array_agg(a.id), '{}') into v_retired_a from business_entity_assets a where a.business_entity_id = p_entity_id and a.is_active;
    select coalesce(array_agg(l.id), '{}') into v_retired_l from business_entity_liabilities l where l.business_entity_id = p_entity_id and l.is_active;
    update business_entity_assets set is_active = false, updated_at = now() where id = any (v_retired_a);
    update business_entity_liabilities set is_active = false, updated_at = now() where id = any (v_retired_l);
    update business_entities set valuation_mode = 'detailed', summary_net_asset_value = null, updated_at = now() where id = p_entity_id;
    for v_item in select * from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) loop
      insert into business_entity_assets(user_id, business_entity_id, label, asset_type, value, currency_code, as_at_date, notes)
      values (v_uid, p_entity_id, v_item ->> 'label', v_item ->> 'asset_type', (v_item ->> 'value')::numeric,
              coalesce(v_item ->> 'currency_code', v_e.currency_code), nullif(v_item ->> 'as_at_date', '')::date, v_item ->> 'notes');
    end loop;
    for v_item in select * from jsonb_array_elements(coalesce(p_liabilities, '[]'::jsonb)) loop
      insert into business_entity_liabilities(user_id, business_entity_id, label, liability_type, value, currency_code, lender, interest_rate, monthly_repayment, as_at_date, notes)
      values (v_uid, p_entity_id, v_item ->> 'label', v_item ->> 'liability_type', (v_item ->> 'value')::numeric,
              coalesce(v_item ->> 'currency_code', v_e.currency_code), v_item ->> 'lender', nullif(v_item ->> 'interest_rate', '')::numeric,
              nullif(v_item ->> 'monthly_repayment', '')::numeric, nullif(v_item ->> 'as_at_date', '')::date, v_item ->> 'notes');
    end loop;
  else
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_snapshot from business_entity_assets a where a.business_entity_id = p_entity_id and a.is_active;
    v_snapshot := jsonb_build_object('assets', v_snapshot,
      'liabilities', (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from business_entity_liabilities l where l.business_entity_id = p_entity_id and l.is_active));
    update business_entity_assets set is_active = false, updated_at = now() where business_entity_id = p_entity_id and is_active;
    update business_entity_liabilities set is_active = false, updated_at = now() where business_entity_id = p_entity_id and is_active;
    update business_entities set valuation_mode = 'summary', summary_net_asset_value = p_net, updated_at = now() where id = p_entity_id;
  end if;

  perform set_config('fhip.entity_mode_switch', '', true);

  insert into entity_figure_mode_log(user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation)
  values (v_uid, v_e.entity_type, p_entity_id, case when p_to_mode = 'detailed' then 'to_itemised' else 'to_net_only' end,
          v_e.valuation_mode, p_to_mode, v_net_before, v_net_after, round(v_net_after - v_net_before, 2), v_snapshot);

  return jsonb_build_object('status', 'applied', 'from_mode', v_e.valuation_mode, 'to_mode', p_to_mode,
                            'net_before', v_net_before, 'net_after', v_net_after, 'variance', round(v_net_after - v_net_before, 2));
end;
$fn$;

revoke all on function business_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, boolean) from public;
revoke all on function business_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, boolean) from anon;
grant execute on function business_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, boolean) to authenticated;

comment on function business_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, boolean) is
  'Changes how a Company, Family Trust or HUF is recorded, itemised or net value only. Preview first (p_confirm false changes nothing and returns the net before and after), then one transaction: the new representation is written, the old one is retired and kept in entity_figure_mode_log. Never leaves both counted.';

commit;
