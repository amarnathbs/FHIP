-- 0297 -- Company, Family Trust and HUF: richer assets and liabilities, the itemised OR net value only rule in the database, a preview-first
-- switch with history, and audit triggers for every entity level line (DOCUMENT2 (4) review, work package C, finding F23b).
-- Additive only, forward only. Builds on entity phase 1 (0289, 0290) and 0296.
--
-- WHAT THE PO FOUND. An SMSF could record assets and liabilities separately, a Company, Family Trust or HUF could not do it at the same level:
-- a line was only a label and a value, with no type, no as-at date, no lender, rate or repayment, no provenance, a hard delete and no audit trail,
-- and nothing in the database stopped an entity holding BOTH a typed net value and itemised lines (only the application chose one).
--
-- THE RULE (PO, same as the SMSF). An entity is recorded in exactly one of two ways:
--   itemised (valuation_mode = detailed)     assets and liabilities are entered, the net is DERIVED, no typed net exists.
--   net value only (valuation_mode = summary) one typed net, no itemised line is active.
-- Enforced here, not only on screen:
--   a. trg_business_entities_mode_rule   the way an entity is recorded changes only inside the switch function below (a transaction local
--                                        bracket, the same technique 0090 and 0290 use), an itemised entity cannot carry a typed net.
--   b. trg_business_entity_assets_mode_rule and trg_business_entity_liabilities_mode_rule   an ACTIVE line needs an itemised entity.
--   Existing rows that already break the rule are NOT touched. The triggers act on a change of the mode, the typed net or is_active only, and
--   business_entity_mode_rule_violations() lists them so the user decides. Nothing is deleted: lines are retired with is_active, the typed net
--   is kept in entity_figure_mode_log (0290).
--
-- NEW COLUMNS (all nullable or defaulted, no existing row changes):
--   business_entity_assets      asset_type, as_at_date, country_code, source_type, is_active
--   business_entity_liabilities liability_type, lender, interest_rate, monthly_repayment, as_at_date, country_code, source_type, is_active
--
-- AUDIT. Every insert and meaningful change of an entity level line (Company, Trust, HUF lines and the SMSF holdings and liabilities) writes one
-- row to entity_change_log (0296).
--
-- APPLY ORDER. This migration must be applied BEFORE the matching code is deployed, because the code reads is_active on the two line tables.
--
-- ROLLBACK: drop the triggers and functions named below, drop the added columns, re-create nothing (no earlier object is replaced).
-- Safe while no line has been retired, otherwise re-activate the retired lines first.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Line detail
-- ---------------------------------------------------------------------------------------------------------------------
alter table business_entity_assets
  add column if not exists asset_type text,
  add column if not exists as_at_date date,
  add column if not exists country_code char(2) references countries(country_code),
  add column if not exists source_type text not null default 'manual',
  add column if not exists is_active boolean not null default true;

alter table business_entity_assets drop constraint if exists chk_business_entity_assets_type;
alter table business_entity_assets
  add constraint chk_business_entity_assets_type
    check (asset_type is null or asset_type in ('cash', 'property', 'shares_investments', 'business_assets', 'vehicle_equipment', 'other'));
alter table business_entity_assets drop constraint if exists chk_business_entity_assets_source;
alter table business_entity_assets
  add constraint chk_business_entity_assets_source check (source_type in ('manual', 'statement_import'));

alter table business_entity_liabilities
  add column if not exists liability_type text,
  add column if not exists lender text,
  add column if not exists interest_rate numeric(6, 3),
  add column if not exists monthly_repayment numeric(18, 2),
  add column if not exists as_at_date date,
  add column if not exists country_code char(2) references countries(country_code),
  add column if not exists source_type text not null default 'manual',
  add column if not exists is_active boolean not null default true;

alter table business_entity_liabilities drop constraint if exists chk_business_entity_liabilities_type;
alter table business_entity_liabilities
  add constraint chk_business_entity_liabilities_type
    check (liability_type is null or liability_type in ('property_loan', 'other_loan', 'tax_payable', 'trade_creditors', 'other'));
alter table business_entity_liabilities drop constraint if exists chk_business_entity_liabilities_rate;
alter table business_entity_liabilities
  add constraint chk_business_entity_liabilities_rate
    check ((interest_rate is null or (interest_rate >= 0 and interest_rate <= 100)) and (monthly_repayment is null or monthly_repayment >= 0));
alter table business_entity_liabilities drop constraint if exists chk_business_entity_liabilities_source;
alter table business_entity_liabilities
  add constraint chk_business_entity_liabilities_source check (source_type in ('manual', 'statement_import'));

create index if not exists idx_business_entity_assets_active on business_entity_assets(business_entity_id) where is_active;
create index if not exists idx_business_entity_liabilities_active on business_entity_liabilities(business_entity_id) where is_active;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The rule, in the database
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function business_entities_mode_rule() returns trigger as $fn$
declare
  v_switching boolean := coalesce(current_setting('fhip.entity_mode_switch', true), '') = 'certified';
begin
  if tg_op = 'UPDATE' and new.valuation_mode is distinct from old.valuation_mode and not v_switching then
    raise exception 'ENTITY_MODE_SWITCH_ONLY: the way an entity is recorded (itemised or net value only) changes only through business_entity_switch_mode(), which keeps the history and never leaves both representations counted'
      using errcode = '42501';
  end if;
  if new.valuation_mode = 'detailed' and new.summary_net_asset_value is not null
     and (tg_op = 'INSERT' or new.valuation_mode is distinct from old.valuation_mode or new.summary_net_asset_value is distinct from old.summary_net_asset_value) then
    raise exception 'ENTITY_BOTH_REPRESENTATIONS: an itemised entity derives its net out of its assets and liabilities, so it cannot also carry a typed net value'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_business_entities_mode_rule on business_entities;
create trigger trg_business_entities_mode_rule
  before insert or update of valuation_mode, summary_net_asset_value on business_entities
  for each row execute function business_entities_mode_rule();

create or replace function business_entity_lines_mode_rule() returns trigger as $fn$
declare
  v_mode text;
begin
  if new.is_active then
    select e.valuation_mode into v_mode from business_entities e where e.id = new.business_entity_id;
    if v_mode is distinct from 'detailed' then
      raise exception 'ENTITY_BOTH_REPRESENTATIONS: this entity is recorded as a net value only, so assets and liabilities cannot be added to it, switch it to itemised first'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_business_entity_assets_mode_rule on business_entity_assets;
create trigger trg_business_entity_assets_mode_rule
  before insert or update of is_active on business_entity_assets
  for each row execute function business_entity_lines_mode_rule();

drop trigger if exists trg_business_entity_liabilities_mode_rule on business_entity_liabilities;
create trigger trg_business_entity_liabilities_mode_rule
  before insert or update of is_active on business_entity_liabilities
  for each row execute function business_entity_lines_mode_rule();

-- Data quality: entities that already hold both representations. Security invoker, so each user sees only their own entities.
create or replace function business_entity_mode_rule_violations()
returns table (entity_id uuid, entity_name text, kind text, detail text) as $fn$
  select e.id, e.name, 'itemised_with_typed_net'::text,
         ('typed net value ' || e.summary_net_asset_value::text || ' is still recorded on an itemised entity')::text
  from business_entities e
  where e.is_active and e.valuation_mode = 'detailed' and e.summary_net_asset_value is not null
  union all
  select e.id, e.name, 'net_only_with_active_lines'::text,
         ((select count(*) from business_entity_assets a where a.business_entity_id = e.id and a.is_active)::text || ' asset line(s) and '
          || (select count(*) from business_entity_liabilities l where l.business_entity_id = e.id and l.is_active)::text || ' liability line(s) are active on a net value only entity')::text
  from business_entities e
  where e.is_active and e.valuation_mode = 'summary'
    and (exists (select 1 from business_entity_assets a where a.business_entity_id = e.id and a.is_active)
         or exists (select 1 from business_entity_liabilities l where l.business_entity_id = e.id and l.is_active));
$fn$ language sql stable;

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

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Audit triggers for every entity level line
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_line_audit() returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_kind text;
  v_entity uuid;
  v_action text;
begin
  if tg_table_name in ('business_entity_assets', 'business_entity_liabilities') then
    v_entity := new.business_entity_id;
    select e.entity_type into v_kind from business_entities e where e.id = v_entity;
  else
    v_entity := new.smsf_fund_id;
    v_kind := 'smsf';
  end if;
  if v_kind is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif new.is_active = false and old.is_active then
    v_action := 'retire';
  else
    v_action := 'update';
  end if;
  insert into entity_change_log(user_id, entity_kind, entity_id, table_name, row_id, action, old_values, new_values)
  values (new.user_id, v_kind, v_entity, tg_table_name, new.id, v_action,
          case when tg_op = 'UPDATE' then to_jsonb(old) else null end, to_jsonb(new));
  return new;
end;
$fn$;

revoke all on function entity_line_audit() from public;

drop trigger if exists trg_business_entity_assets_audit on business_entity_assets;
create trigger trg_business_entity_assets_audit
  after insert or update of label, asset_type, value, currency_code, as_at_date, notes, is_active on business_entity_assets
  for each row execute function entity_line_audit();

drop trigger if exists trg_business_entity_liabilities_audit on business_entity_liabilities;
create trigger trg_business_entity_liabilities_audit
  after insert or update of label, liability_type, value, currency_code, lender, interest_rate, monthly_repayment, as_at_date, notes, is_active on business_entity_liabilities
  for each row execute function entity_line_audit();

drop trigger if exists trg_smsf_holdings_audit on smsf_holdings;
create trigger trg_smsf_holdings_audit
  after insert or update of holding_name, holding_type, value, currency_code, notes, is_active on smsf_holdings
  for each row execute function entity_line_audit();

drop trigger if exists trg_smsf_liabilities_audit on smsf_liabilities;
create trigger trg_smsf_liabilities_audit
  after insert or update of liability_name, liability_type, balance, currency_code, lender, interest_rate, monthly_repayment, notes, is_active on smsf_liabilities
  for each row execute function entity_line_audit();

commit;
