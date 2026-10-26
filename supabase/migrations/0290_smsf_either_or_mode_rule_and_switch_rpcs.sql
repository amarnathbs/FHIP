-- 0290 -- SMSF itemised OR net value only, never both enforced in the database, the entity_figure_mode_log history,
-- and the atomic switch / undo / move / adopt functions (entity-level assets and liabilities, part 2 of 2).
--
-- THE RULE (PO decision 17-10-2026). A fund is recorded in exactly one of two ways:
--   itemised (smsf_funds.mode = detailed): assets and liabilities are entered, the net is DERIVED, no typed net exists.
--   net value only (mode = summary): one typed net, no itemised line is active.
-- Never both counted. This migration makes that true in the database, not only in the screens:
--   a. trg_smsf_funds_mode_rule: the recording mode can change only inside a switch function (a transaction-local
--      certified bracket, the technique migration 0090 uses for the balance), an itemised fund cannot carry a typed net.
--   b. trg_smsf_holdings_mode_rule / trg_smsf_liabilities_mode_rule: an ACTIVE line needs an itemised fund.
--   Existing rows that already break the rule (for example the PO fund: itemised with a stale typed net of 138,000) are
--   NOT touched and are NOT stopped during ordinary maintenance: the triggers act on a change of the mode, the typed net or
--   the is_active flag only. smsf_mode_rule_violations() lists them so the user decides, the functions below retire the
--   other representation with a confirmation and a history row. A later migration can express the rule as CHECK
--   constraints, validated once no violating row remains.
--
-- NUMBERS. Mode changes go through smsf_entity_switch_mode(), which is PREVIEW-FIRST: called with p_confirm = false it
-- changes nothing and returns the before/after net, called with p_confirm = true it applies, in one transaction, the new
-- representation AND the retirement of the old one, and writes one entity_figure_mode_log row. Nothing is deleted:
-- lines are archived (is_active = false), the typed net is kept in the log. Undo restores the previous representation.
--
-- The earlier two-step functions smsf_switch_to_detailed() (0090) and smsf_switch_to_summary() (0089) staged lines in a
-- Summary fund, which the rule forbids, they are replaced by versions that refuse with a pointer to the new function.
--
-- ROLLBACK: drop the three triggers, the functions and entity_figure_mode_log, re-create the two old switch functions from
-- migrations 0090 and 0089. Safe while entity_figure_mode_log is empty or its history is exported first.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. History: append-only
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists entity_figure_mode_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('smsf', 'company', 'family_trust', 'huf')),
  entity_id uuid not null,
  action text not null check (action in ('to_itemised', 'to_net_only', 'retire_typed_net', 'move_loan', 'adopt_register_rows', 'undo')),
  from_mode text,
  to_mode text,
  net_before numeric(18, 2),
  net_after numeric(18, 2),
  variance numeric(18, 2),
  retired_representation jsonb not null default '{}'::jsonb,
  undoes_log_id uuid references entity_figure_mode_log(id),
  created_at timestamptz not null default now()
);

comment on table entity_figure_mode_log is
  'Append-only history of every change of how an entity''s figure is recorded (migration 0290): who, which entity, what was retired (typed net or the full set of lines), net before and after. Written only by the smsf_entity_* functions, the owner can read it and can neither update nor delete it.';

create index if not exists idx_entity_figure_mode_log_entity on entity_figure_mode_log(entity_id, created_at desc);
create index if not exists idx_entity_figure_mode_log_user on entity_figure_mode_log(user_id);

alter table entity_figure_mode_log enable row level security;
drop policy if exists own_rows_entity_figure_mode_log_read on entity_figure_mode_log;
create policy own_rows_entity_figure_mode_log_read on entity_figure_mode_log for select using (auth.uid() = user_id);

create or replace function entity_figure_mode_log_append_only() returns trigger as $fn$
begin
  raise exception 'entity_figure_mode_log is append-only' using errcode = '42501';
end;
$fn$ language plpgsql;

drop trigger if exists trg_entity_figure_mode_log_no_update on entity_figure_mode_log;
create trigger trg_entity_figure_mode_log_no_update
  before update on entity_figure_mode_log
  for each row execute function entity_figure_mode_log_append_only();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The rule, in the database
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_funds_mode_rule() returns trigger as $fn$
declare
  v_switching boolean := coalesce(current_setting('fhip.entity_mode_switch', true), '') = 'certified';
begin
  if tg_op = 'UPDATE' and new.mode is distinct from old.mode and not v_switching then
    raise exception 'ENTITY_MODE_SWITCH_ONLY: the way a fund is recorded (itemised or net value only) changes only through smsf_entity_switch_mode(), which keeps the history and never leaves both representations counted'
      using errcode = '42501';
  end if;
  if new.mode = 'detailed' and new.summary_balance is not null
     and (tg_op = 'INSERT' or new.mode is distinct from old.mode or new.summary_balance is distinct from old.summary_balance) then
    raise exception 'ENTITY_BOTH_REPRESENTATIONS: an itemised fund derives its net out of its assets and liabilities, so it cannot also carry a typed net value'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_smsf_funds_mode_rule on smsf_funds;
create trigger trg_smsf_funds_mode_rule
  before insert or update of mode, summary_balance on smsf_funds
  for each row execute function smsf_funds_mode_rule();

create or replace function smsf_lines_mode_rule() returns trigger as $fn$
declare
  v_mode text;
begin
  if new.is_active then
    select f.mode into v_mode from smsf_funds f where f.id = new.smsf_fund_id;
    if v_mode is distinct from 'detailed' then
      raise exception 'ENTITY_BOTH_REPRESENTATIONS: this fund is recorded as a net value only, so assets and liabilities cannot be added to it, switch it to itemised first'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_smsf_holdings_mode_rule on smsf_holdings;
create trigger trg_smsf_holdings_mode_rule
  before insert or update of is_active on smsf_holdings
  for each row execute function smsf_lines_mode_rule();

drop trigger if exists trg_smsf_liabilities_mode_rule on smsf_liabilities;
create trigger trg_smsf_liabilities_mode_rule
  before insert or update of is_active on smsf_liabilities
  for each row execute function smsf_lines_mode_rule();

-- Data quality: funds that already hold both representations. Security invoker, so each user sees only their own funds.
create or replace function smsf_mode_rule_violations()
returns table (fund_id uuid, fund_name text, kind text, detail text) as $fn$
  select f.id, f.fund_name, 'itemised_with_typed_net'::text,
         ('typed net value ' || f.summary_balance::text || ' is still recorded on an itemised fund')::text
  from smsf_funds f
  where f.is_active and f.mode = 'detailed' and f.summary_balance is not null
  union all
  select f.id, f.fund_name, 'net_only_with_active_lines'::text,
         ((select count(*) from smsf_holdings h where h.smsf_fund_id = f.id and h.is_active)::text || ' asset line(s) and '
          || (select count(*) from smsf_liabilities l where l.smsf_fund_id = f.id and l.is_active)::text || ' liability line(s) are active on a net-value-only fund')::text
  from smsf_funds f
  where f.is_active and f.mode = 'summary'
    and (exists (select 1 from smsf_holdings h where h.smsf_fund_id = f.id and h.is_active)
         or exists (select 1 from smsf_liabilities l where l.smsf_fund_id = f.id and l.is_active));
$fn$ language sql stable;

comment on function smsf_mode_rule_violations() is
  'Lists funds that hold BOTH an itemised set and a typed net (itemised_with_typed_net, net_only_with_active_lines). Only one of them is ever counted (the mode decides), but the user is asked to retire the other, through smsf_entity_retire_typed_net() or smsf_entity_switch_mode().';

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

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Move a linked personal loan across to the fund (the fund net does not change: the loan is counted once, before and after)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_entity_move_linked_loan(p_fund_id uuid, p_liability_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_liab record;
  v_link record;
  v_net_before numeric;
  v_net_after numeric;
  v_new_id uuid;
  v_log_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' not found or not visible to the current user', errcode = 'P0002';
  end if;
  if v_fund.mode <> 'detailed' then
    raise exception 'smsf: record the fund as itemised first, then move the loan across' using errcode = '55000';
  end if;
  select * into v_liab from liabilities where id = p_liability_id and user_id = v_uid and is_active;
  if not found then
    raise exception 'smsf: that liability was not found, or is not active' using errcode = 'P0002';
  end if;
  select * into v_link from property_liability_links
  where liability_id = p_liability_id and user_id = v_uid and linked_retirement_id = v_fund.retirement_account_id
    and link_type = 'smsf_property_loan' and is_active
  limit 1;
  if not found then
    raise exception 'smsf: that liability is not linked to this fund as its property loan' using errcode = '55000';
  end if;

  v_net_before := smsf_fund_counted_net(p_fund_id);

  begin
    insert into smsf_liabilities (user_id, smsf_fund_id, liability_name, liability_type, lender, balance, interest_rate, monthly_repayment, currency_code, country_code, notes)
    values (v_uid, p_fund_id, v_liab.liability_name, 'property_loan', v_liab.lender, v_liab.balance, v_liab.interest_rate, v_liab.monthly_repayment,
            v_liab.currency_code, v_liab.country_code, 'Moved across to the fund after being a personal liabilities row.')
    returning id into v_new_id;
    update property_liability_links set is_active = false where id = v_link.id;
    update liabilities set is_active = false, updated_at = now() where id = p_liability_id;
    perform smsf_recompute_fund(p_fund_id);
    v_net_after := smsf_fund_counted_net(p_fund_id);
    if not p_confirm then
      raise exception 'preview only' using errcode = 'FPRV1';
    end if;
    insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation)
    values (v_uid, 'smsf', p_fund_id, 'move_loan', 'detailed', 'detailed', v_net_before, v_net_after,
            round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2),
            jsonb_build_object('liability_id', p_liability_id, 'link_id', v_link.id, 'smsf_liability_id', v_new_id,
                               'liability_name', v_liab.liability_name, 'balance', v_liab.balance, 'currency_code', v_liab.currency_code))
    returning id into v_log_id;
  exception when sqlstate 'FPRV1' then
    return jsonb_build_object('status', 'preview', 'net_before', v_net_before, 'net_after', v_net_after,
                              'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
  end;

  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'smsf_liability_id', v_new_id, 'net_before', v_net_before, 'net_after', v_net_after,
                            'variance', round(coalesce(v_net_after, 0) - coalesce(v_net_before, 0), 2));
end;
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Adopt (archive) register rows that duplicate the fund: Retirement rows owned by the SMSF
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_entity_adopt_register_rows(p_fund_id uuid, p_retirement_row_ids uuid[], p_confirm boolean default false) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_rows jsonb;
  v_total numeric;
  v_net numeric;
  v_n int;
  v_log_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund ' || p_fund_id::text || ' not found or not visible to the current user', errcode = 'P0002';
  end if;
  if p_retirement_row_ids is null or cardinality(p_retirement_row_ids) = 0 then
    raise exception 'smsf: name the register rows to archive' using errcode = '22023';
  end if;

  select count(*), coalesce(sum(r.current_balance), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'account_name', r.account_name, 'current_balance', r.current_balance, 'currency_code', r.currency_code, 'owner', r.owner)), '[]'::jsonb)
    into v_n, v_total, v_rows
  from retirement_accounts r
  where r.id = any (p_retirement_row_ids) and r.user_id = v_uid and r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf';
  if v_n <> cardinality(p_retirement_row_ids) then
    raise exception using message = 'smsf: only active Retirement rows owned by the SMSF (and not the fund record itself) can be archived this way, ' || v_n::text || ' of ' || cardinality(p_retirement_row_ids)::text || ' qualify', errcode = '55000';
  end if;

  v_net := smsf_fund_counted_net(p_fund_id);

  if not p_confirm then
    return jsonb_build_object('status', 'preview', 'rows', v_rows, 'register_total', v_total, 'fund_net', v_net);
  end if;

  update retirement_accounts set is_active = false, updated_at = now() where id = any (p_retirement_row_ids) and user_id = v_uid;
  insert into entity_figure_mode_log (user_id, entity_kind, entity_id, action, from_mode, to_mode, net_before, net_after, variance, retired_representation)
  values (v_uid, 'smsf', p_fund_id, 'adopt_register_rows', v_fund.mode, v_fund.mode, v_net, v_net, 0,
          jsonb_build_object('retirement_rows', v_rows, 'register_total', v_total))
  returning id into v_log_id;
  return jsonb_build_object('status', 'applied', 'log_id', v_log_id, 'rows', v_rows, 'register_total', v_total, 'fund_net', v_net);
end;
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The two earlier two-step switch functions stage lines in a net-value fund, which the rule forbids.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_switch_to_detailed(p_fund_id uuid) returns numeric as $fn$
begin
  raise exception 'smsf: use smsf_entity_switch_mode() to record the fund as itemised, assets and liabilities are entered as part of the switch'
    using errcode = '0A000';
end;
$fn$ language plpgsql;

create or replace function smsf_switch_to_summary(p_fund_id uuid, p_new_summary_balance numeric, p_new_summary_balance_date date) returns numeric as $fn$
begin
  raise exception 'smsf: use smsf_entity_switch_mode() to record the fund as a net value only'
    using errcode = '0A000';
end;
$fn$ language plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Who may call what
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean) from public, anon;
revoke all on function smsf_entity_undo_last_switch(uuid, boolean) from public, anon;
revoke all on function smsf_entity_retire_typed_net(uuid, boolean) from public, anon;
revoke all on function smsf_entity_move_linked_loan(uuid, uuid, boolean) from public, anon;
revoke all on function smsf_entity_adopt_register_rows(uuid, uuid[], boolean) from public, anon;
do $fn$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean) to authenticated;
    grant execute on function smsf_entity_undo_last_switch(uuid, boolean) to authenticated;
    grant execute on function smsf_entity_retire_typed_net(uuid, boolean) to authenticated;
    grant execute on function smsf_entity_move_linked_loan(uuid, uuid, boolean) to authenticated;
    grant execute on function smsf_entity_adopt_register_rows(uuid, uuid[], boolean) to authenticated;
  end if;
end $fn$;

commit;
