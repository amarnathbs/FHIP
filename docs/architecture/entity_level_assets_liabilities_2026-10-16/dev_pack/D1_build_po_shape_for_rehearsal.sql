-- D1 REHEARSAL FIXTURE (WRITES, DEV ONLY, never on production). Builds the PO household shape for a DEV test login so the production pack can be rehearsed.
-- Use a DEV test account that has NO SMSF yet (it refuses otherwise). Replace PUT_YOUR_LOGIN_EMAIL_HERE (the only edit, keep the quotes).
-- The account must have confirmed Australia as its country. It adds: an itemised SMSF fund with three assets (475000 + 3000 + 25000), a leftover typed net
-- value of 138000, a duplicate Retirement row of 133000 owned by the SMSF, an inactive personal SMSF loan row of 365000, an inactive SMSF-owned asset
-- Trust Assets of 495000, and personal figures that net to 874441 (assets 1670298, investments 590000, loans 600000 and 700000 and 85857).
-- Needs migrations 0289 and 0290 applied. It pauses two rule triggers for the statements that write the leftover typed net, then switches them back on.
begin;

do $fn$
declare
  v_uid uuid;
  v_ra uuid;
  v_fund uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE');
  if v_uid is null then
    raise exception 'no such user, check the e-mail';
  end if;
  if exists (select 1 from retirement_accounts where user_id = v_uid and master_item_key = 'smsf') then
    raise exception 'this account already has an SMSF fund, use a DEV test account without one';
  end if;

  insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner) values (v_uid, 'Rehearsal assets register', 'other', 1670298, 'AUD', 'self');
  insert into investments (user_id, investment_name, investment_type, current_value, currency_code, owner) values (v_uid, 'Rehearsal investments', 'shares', 590000, 'AUD', 'self');
  insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner) values
    (v_uid, 'Rehearsal home loan', 'mortgage', 600000, 'AUD', 'self'),
    (v_uid, 'Rehearsal investment loan', 'mortgage', 700000, 'AUD', 'joint'),
    (v_uid, 'Rehearsal car loan', 'auto_loan', 85857, 'AUD', 'spouse');

  insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
  values (v_uid, 'SMSF', 'super', 0, 'AUD', 'AU', 'self', 'smsf', true) returning id into v_ra;
  insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, currency_code)
  values (v_uid, v_ra, 'Rehearsal SMSF', 'detailed', null, 'AUD') returning id into v_fund;
  insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values
    (v_uid, v_fund, 'property', 'residential_property', 'Rehearsal property', 475000, 'AUD'),
    (v_uid, v_fund, 'cash', 'cash_account', 'Rehearsal bank account', 3000, 'AUD'),
    (v_uid, v_fund, 'cash', 'cash_account', 'Rehearsal secured finance', 25000, 'AUD');

  alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;
  update smsf_funds set summary_balance = 138000 where id = v_fund;
  alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;

  insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
  values (v_uid, 'Other Retirement Assets', 'other', 133000, 'AUD', 'AU', 'smsf', 'other_retirement', true);
  insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, is_active) values (v_uid, 'SMSF property loan', 'mortgage', 365000, 'AUD', 'joint', false);
  insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, is_active) values (v_uid, 'Trust Assets', 'other', 495000, 'AUD', 'smsf', false);
end
$fn$;

commit;
