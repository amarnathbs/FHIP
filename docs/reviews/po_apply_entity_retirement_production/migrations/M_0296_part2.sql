-- Migration 0296 part 2 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Row level security, the same shape on both tables
-- ---------------------------------------------------------------------------------------------------------------------
alter table entity_income_items enable row level security;
drop policy if exists own_rows_entity_income_items on entity_income_items;
create policy own_rows_entity_income_items on entity_income_items
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      (entity_kind = 'smsf' and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid()))
      or (entity_kind <> 'smsf' and business_entity_id in (select id from business_entities where user_id = auth.uid()))
    )
  );

alter table entity_expense_items enable row level security;
drop policy if exists own_rows_entity_expense_items on entity_expense_items;
create policy own_rows_entity_expense_items on entity_expense_items
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      (entity_kind = 'smsf' and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid()))
      or (entity_kind <> 'smsf' and business_entity_id in (select id from business_entities where user_id = auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Scope rule. The entity belongs to the caller, a Company Trust or HUF row matches the entity type, a rent record ties only to a property
--    asset of the same entity and never while the asset still points at a personal income record
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_income_rent_rule(r entity_income_items) returns void as $fn$
declare
  v_legacy uuid;
begin
  if r.income_type = 'rent' and r.is_active then
    if r.smsf_holding_id is not null then
      if not exists (
        select 1 from smsf_holdings h
        where h.id = r.smsf_holding_id and h.smsf_fund_id = r.smsf_fund_id and h.user_id = r.user_id and h.holding_class = 'property'
      ) then
        raise exception 'ENTITY_RENT_ASSET: rent can only be tied to a property asset of the same fund' using errcode = '23514';
      end if;
      select h.linked_income_source_id into v_legacy from smsf_holdings h where h.id = r.smsf_holding_id;
      if v_legacy is not null and exists (select 1 from income_sources s where s.id = v_legacy and s.is_active) then
        raise exception 'ENTITY_RENT_ALREADY_RECORDED: this property already points at an income record entered the earlier way, move that record to the fund instead of adding the rent twice'
          using errcode = '23505';
      end if;
    end if;
    if r.business_entity_asset_id is not null then
      if not exists (
        select 1 from business_entity_assets a
        where a.id = r.business_entity_asset_id and a.business_entity_id = r.business_entity_id and a.user_id = r.user_id
      ) then
        raise exception 'ENTITY_RENT_ASSET: rent can only be tied to an asset of the same entity' using errcode = '23514';
      end if;
    end if;
  end if;
end;
$fn$ language plpgsql;

create or replace function entity_item_scope_rule() returns trigger as $fn$
declare
  v_type text;
  v_user uuid;
begin
  if new.entity_kind = 'smsf' then
    select f.user_id into v_user from smsf_funds f where f.id = new.smsf_fund_id;
    if v_user is distinct from new.user_id then
      raise exception 'ENTITY_NOT_YOURS: that fund was not found' using errcode = '42501';
    end if;
  else
    select e.user_id, e.entity_type into v_user, v_type from business_entities e where e.id = new.business_entity_id;
    if v_user is distinct from new.user_id then
      raise exception 'ENTITY_NOT_YOURS: that entity was not found' using errcode = '42501';
    end if;
    if v_type is distinct from new.entity_kind then
      raise exception 'ENTITY_KIND_MISMATCH: this record says it belongs to a different kind of entity' using errcode = '23514';
    end if;
  end if;

  if tg_table_name = 'entity_income_items' then
    perform entity_income_rent_rule(new);
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_entity_income_scope on entity_income_items;
create trigger trg_entity_income_scope
  before insert or update of entity_kind, smsf_fund_id, business_entity_id, smsf_holding_id, business_entity_asset_id, income_type, is_active on entity_income_items
  for each row execute function entity_item_scope_rule();

drop trigger if exists trg_entity_expense_scope on entity_expense_items;
create trigger trg_entity_expense_scope
  before insert or update of entity_kind, smsf_fund_id, business_entity_id on entity_expense_items
  for each row execute function entity_item_scope_rule();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Audit triggers. They fire on insert and on a change of a meaningful column, not on the link being cleared when an asset is deleted
--    (that keeps an account deletion cascade clear of the log)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_item_audit() returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := case when new.source_type = 'moved_from_personal' then 'moved_from_personal' else 'insert' end;
  elsif new.is_active = false and old.is_active then
    v_action := 'retire';
  else
    v_action := 'update';
  end if;
  insert into entity_change_log(user_id, entity_kind, entity_id, table_name, row_id, action, old_values, new_values)
  values (
    new.user_id, new.entity_kind, coalesce(new.smsf_fund_id, new.business_entity_id), tg_table_name, new.id, v_action,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new)
  );
  return new;
end;
$fn$;

revoke all on function entity_item_audit() from public;

drop trigger if exists trg_entity_income_audit on entity_income_items;
create trigger trg_entity_income_audit
  after insert or update of income_type, income_name, amount, frequency, currency_code, notes, is_active on entity_income_items
  for each row execute function entity_item_audit();

drop trigger if exists trg_entity_expense_audit on entity_expense_items;
create trigger trg_entity_expense_audit
  after insert or update of expense_type, expense_name, amount, frequency, currency_code, notes, is_active on entity_expense_items
  for each row execute function entity_item_audit();

commit;
