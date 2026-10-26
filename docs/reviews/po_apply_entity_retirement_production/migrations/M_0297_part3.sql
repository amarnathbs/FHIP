-- Migration 0297 part 3 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

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
