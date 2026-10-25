-- Migration 0289 part 2 of 3: functions and triggers. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- Same fx convention as smsf_holdings_total_aud() (migration 0084): INR per 1 AUD, AUD = INR / rate.
create or replace function smsf_liabilities_total_aud(p_fund_id uuid) returns numeric as $fn$
declare
  fx numeric;
  total numeric;
begin
  select assumption_value into fx
  from forecast_global_assumptions
  where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true
  limit 1;
  fx := coalesce(fx, 56.0);

  select coalesce(sum(case when currency_code = 'INR' then balance / fx else balance end), 0) into total
  from smsf_liabilities
  where smsf_fund_id = p_fund_id and is_active = true;

  return total;
end;
$fn$ language plpgsql stable;

create or replace function smsf_compute_detailed_net_value(p_fund_id uuid) returns numeric as $fn$
begin
  return smsf_holdings_total_aud(p_fund_id) - smsf_liabilities_total_aud(p_fund_id) - smsf_linked_loans_total_aud(p_fund_id);
end;
$fn$ language plpgsql stable;

comment on function smsf_compute_detailed_net_value(uuid) is
  'Itemised SMSF net = active holdings minus the fund''s own active liabilities (smsf_liabilities, 0289) minus any still-linked legacy personal loans (property_liability_links, 0084). Derived, never typed.';

-- The fund row in the Retirement register mirrors the derived net, but retirement_accounts.current_balance carries a
-- CHECK (current_balance >= 0) (migration 0003). A fund that owes more than it owns has a genuinely NEGATIVE net, which
-- smsf_funds.detailed_net_value keeps exactly (PO decision: a negative entity net flows through as negative), only the
-- retirement mirror is floored at zero. Anything that wants the true net reads smsf_fund_counted_net(), never the mirror.
-- PREDECESSOR: smsf_recompute_fund() as re-declared by migration 0148 (security definer, certified balance bracket), the
-- only change is greatest(v_net, 0) on the mirror write.
create or replace function smsf_recompute_fund(p_fund_id uuid) returns numeric
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_mode text;
  v_retirement_account_id uuid;
  v_net numeric;
begin
  select mode, retirement_account_id into v_mode, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    return null;
  end if;

  v_net := smsf_compute_detailed_net_value(p_fund_id);

  update smsf_funds set detailed_net_value = v_net, updated_at = now() where id = p_fund_id;

  if v_mode = 'detailed' then
    perform set_config('fhip.smsf_balance_write', 'certified', true);
    update retirement_accounts set current_balance = greatest(v_net, 0), updated_at = now()
    where id = v_retirement_account_id;
    perform set_config('fhip.smsf_balance_write', '', true);
  end if;

  return v_net;
end;
$fn$;

-- The net that is COUNTED for a fund: the derived net while itemised (may be negative), the typed net while net value only.
create or replace function smsf_fund_counted_net(p_fund_id uuid) returns numeric as $fn$
  select case when f.mode = 'detailed' then coalesce(f.detailed_net_value, 0) else coalesce(f.summary_balance, 0) end
  from smsf_funds f where f.id = p_fund_id;
$fn$ language sql stable;

create or replace function trg_smsf_recompute_from_liability_row() returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform smsf_recompute_fund(coalesce(new.smsf_fund_id, old.smsf_fund_id));
  return coalesce(new, old);
end;
$fn$;

drop trigger if exists trg_smsf_liabilities_recompute on smsf_liabilities;
create trigger trg_smsf_liabilities_recompute
  after insert or update of balance, currency_code, is_active or delete on smsf_liabilities
  for each row execute function trg_smsf_recompute_from_liability_row();

commit;
