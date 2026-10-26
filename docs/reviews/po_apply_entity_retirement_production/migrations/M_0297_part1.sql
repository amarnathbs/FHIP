-- Migration 0297 part 1 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
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

commit;
