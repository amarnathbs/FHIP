-- Migration 0289 part 3 of 3: create fund. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- smsf_create_fund(): reuse an archived fund row, and choose the recording mode.
-- The 7-argument version defined in migration 0084 is replaced (a second overload would make named-argument calls ambiguous).
drop function if exists smsf_create_fund(text, text, numeric, date, text, char(3), char(2));

create or replace function smsf_create_fund(
  p_account_name text,
  p_fund_name text,
  p_summary_balance numeric default null,
  p_summary_balance_date date default null,
  p_owner text default 'self',
  p_currency_code char(3) default 'AUD',
  p_country_code char(2) default 'AU',
  p_mode text default 'detailed'
) returns table (retirement_account_id uuid, smsf_fund_id uuid) as $fn$
declare
  v_uid uuid := auth.uid();
  v_ra_id uuid;
  v_ra_active boolean;
  v_fund_id uuid;
begin
  if v_uid is null then
    raise exception 'smsf: not authenticated' using errcode = '42501';
  end if;
  if p_mode not in ('detailed', 'summary') then
    raise exception 'smsf: p_mode must be detailed (itemised) or summary (net value only)' using errcode = '22023';
  end if;
  if p_mode = 'summary' and (p_summary_balance is null or p_summary_balance < 0) then
    raise exception 'smsf: a net value is required when the fund is recorded as a net value only' using errcode = '23514';
  end if;

  select ra.id, ra.is_active into v_ra_id, v_ra_active
  from retirement_accounts ra
  where ra.user_id = v_uid and ra.master_item_key = 'smsf';

  if v_ra_id is not null and v_ra_active then
    raise exception 'smsf: you already have an SMSF fund, edit it instead of creating another' using errcode = '23505';
  end if;

  if v_ra_id is not null then
    -- An ARCHIVED fund row holds the unique key: bring it back instead of failing, keeping its recording mode and lines.
    update retirement_accounts
    set is_active = true, account_name = p_account_name, owner = p_owner, updated_at = now()
    where id = v_ra_id;

    select f.id into v_fund_id from smsf_funds f where f.retirement_account_id = v_ra_id;
    if v_fund_id is not null then
      update smsf_funds set is_active = true, fund_name = p_fund_name, updated_at = now() where id = v_fund_id;
      perform smsf_recompute_fund(v_fund_id);
      return query select v_ra_id, v_fund_id;
      return;
    end if;
  else
    insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
    values (v_uid, p_account_name, 'super', coalesce(case when p_mode = 'summary' then p_summary_balance end, 0), p_currency_code, p_country_code, p_owner, 'smsf', true)
    returning id into v_ra_id;
  end if;

  if p_mode = 'summary' then
    insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code)
    values (v_uid, v_ra_id, p_fund_name, 'summary', p_summary_balance, p_summary_balance_date, p_currency_code)
    returning id into v_fund_id;
  else
    insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code, activated_detailed_at)
    values (v_uid, v_ra_id, p_fund_name, 'detailed', null, null, p_currency_code, now())
    returning id into v_fund_id;
  end if;

  return query select v_ra_id, v_fund_id;
end;
$fn$ language plpgsql;

comment on function smsf_create_fund(text, text, numeric, date, text, char(3), char(2), text) is
  'Atomic SMSF fund creation (retirement_accounts + smsf_funds together), 0289. p_mode detailed (default) = itemised: no typed net, assets and liabilities are entered afterwards and the net is derived. p_mode summary = a typed net value only. An archived fund row is reused (it holds unique(user_id, master_item_key)). Runs as the invoking role: RLS, the AU gate (migration 0084) and the balance guard (0090) apply exactly as for a direct insert.';

commit;
