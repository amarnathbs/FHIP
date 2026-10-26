-- Migration 0290 part 1 of 5: history and the rule. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
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

commit;
