-- Migration 0296 part 3 of 3. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Move a legacy personal income or expense row tagged SMSF to the fund (preview first, one transaction)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function entity_income_type_for(p_master_key text, p_income_type text) returns text as $fn$
  select case
    when p_master_key in ('rental_income', 'airbnb_income') or p_income_type = 'rental' then 'rent'
    when p_master_key = 'interest_income' then 'interest'
    when p_master_key = 'dividend_income' then 'dividends'
    when p_master_key in ('trust_distribution', 'managed_fund_distribution', 'partnership_distribution') then 'distributions'
    else 'other'
  end;
$fn$ language sql immutable;

create or replace function smsf_entity_move_personal_cash_flow(
  p_fund_id uuid,
  p_register text,
  p_row_id uuid,
  p_confirm boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_fund record;
  v_inc record;
  v_exp record;
  v_type text;
  v_holding uuid;
  v_new_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  select * into v_fund from smsf_funds where id = p_fund_id and user_id = v_uid and is_active;
  if not found then
    raise exception using message = 'smsf: fund not found', errcode = 'P0002';
  end if;
  if p_register not in ('income', 'expenses') then
    raise exception 'smsf: the register must be income or expenses' using errcode = '22023';
  end if;

  if p_register = 'income' then
    select * into v_inc from income_sources where id = p_row_id and user_id = v_uid and owner = 'smsf' and is_active;
    if not found then
      raise exception using message = 'smsf: that income record was not found or is not tagged to the SMSF', errcode = 'P0002';
    end if;
    v_type := entity_income_type_for(v_inc.master_item_key, v_inc.income_type);
    select h.id into v_holding from smsf_holdings h
      where h.smsf_fund_id = p_fund_id and h.user_id = v_uid and h.linked_income_source_id = p_row_id and h.is_active limit 1;
    if not p_confirm then
      return jsonb_build_object('status', 'preview', 'register', 'income', 'name', v_inc.source_name, 'amount', v_inc.amount,
                                'frequency', v_inc.frequency, 'currency_code', v_inc.currency_code, 'income_type', v_type,
                                'property_asset_id', v_holding);
    end if;
    if v_holding is not null then
      update smsf_holdings set linked_income_source_id = null, updated_at = now() where id = v_holding;
    end if;
    update income_sources set is_active = false, updated_at = now() where id = p_row_id and user_id = v_uid;
    insert into entity_income_items(user_id, entity_kind, smsf_fund_id, income_type, income_name, amount, frequency, currency_code, country_code, smsf_holding_id, source_type)
    values (v_uid, 'smsf', p_fund_id, v_type, v_inc.source_name, v_inc.amount, v_inc.frequency, v_inc.currency_code, 'AU',
            case when v_type = 'rent' then v_holding else null end, 'moved_from_personal')
    returning id into v_new_id;
    return jsonb_build_object('status', 'applied', 'register', 'income', 'entity_item_id', v_new_id);
  end if;

  select * into v_exp from expense_items where id = p_row_id and user_id = v_uid and owner = 'smsf' and is_active;
  if not found then
    raise exception using message = 'smsf: that expense record was not found or is not tagged to the SMSF', errcode = 'P0002';
  end if;
  if v_exp.expense_category = 'debt_repayment' then
    raise exception 'ENTITY_NOT_AN_EXPENSE: a loan repayment is a cash flow, not an expense, record the loan on the fund and FHIP works out the repayment'
      using errcode = '22023';
  end if;
  v_type := case when v_exp.expense_category = 'insurance' then 'insurance' when v_exp.expense_category = 'housing' then 'property_costs' else 'other' end;
  if not p_confirm then
    return jsonb_build_object('status', 'preview', 'register', 'expenses', 'name', v_exp.expense_name, 'amount', v_exp.amount,
                              'frequency', v_exp.frequency, 'currency_code', v_exp.currency_code, 'expense_type', v_type);
  end if;
  update expense_items set is_active = false, updated_at = now() where id = p_row_id and user_id = v_uid;
  insert into entity_expense_items(user_id, entity_kind, smsf_fund_id, expense_type, expense_name, amount, frequency, currency_code, country_code, source_type)
  values (v_uid, 'smsf', p_fund_id, v_type, v_exp.expense_name, v_exp.amount, v_exp.frequency, v_exp.currency_code, 'AU', 'moved_from_personal')
  returning id into v_new_id;
  return jsonb_build_object('status', 'applied', 'register', 'expenses', 'entity_item_id', v_new_id);
end;
$fn$;

revoke all on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) from public;
revoke all on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) from anon;
grant execute on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) to authenticated;

comment on function smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean) is
  'Moves a legacy personal income or expense row tagged SMSF to the fund, preview first, one transaction: the personal row is retired and the fund record is created, so the flow is counted once. A rent record also takes over the property asset link. A loan repayment is refused, it is a cash flow derived out of the fund liabilities, never an expense.';

commit;
