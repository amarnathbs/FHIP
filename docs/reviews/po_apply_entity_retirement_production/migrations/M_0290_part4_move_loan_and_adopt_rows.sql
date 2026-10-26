-- Migration 0290 part 4 of 5: move loan and adopt rows. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

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

commit;
