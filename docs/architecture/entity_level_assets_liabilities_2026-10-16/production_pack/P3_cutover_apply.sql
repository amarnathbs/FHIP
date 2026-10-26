-- P3 CUTOVER APPLY (WRITES). Run only after P1 (backup) and P2 (preview) and after the PO says go.
-- It moves the PO fund to the itemised record: the fund keeps its three assets, gets the SMSF loan as its own liability, the leftover typed net
-- value is retired, and the duplicate Retirement row owned by the SMSF is archived. All in one transaction: if any check fails, nothing changes.
-- Edit the values in the declare block: the login e-mail, the loan amount (370000 is the PO decision of 17-10-2026, 365000 is the stale
-- number on the old inactive row), and the three expected values. The checks stop the script if the data is not exactly as diagnosed.
-- Net worth stays right at every step: personal 874441 does not move, and the SMSF contributes its own net exactly once.
begin;

do $fn$
declare
  v_email text := 'PUT_YOUR_LOGIN_EMAIL_HERE';
  v_loan numeric := 370000;
  v_loan_name text := 'SMSF property loan';
  v_expected_assets numeric := 503000;
  v_expected_dup_total numeric := 133000;
  v_expected_dup_count int := 1;
  v_uid uuid;
  v_fund record;
  v_assets numeric;
  v_dup_ids uuid[];
  v_dup_total numeric;
  v_typed numeric;
  v_net numeric;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'no such user, check the e-mail';
  end if;
  if to_regclass('public.zz_bk_20261017_retirement_accounts') is null then
    raise exception 'no backup found, run P1 first';
  end if;
  if to_regclass('public.smsf_liabilities') is null or to_regprocedure('smsf_entity_retire_typed_net(uuid,boolean)') is null then
    raise exception 'migrations 0289 and 0290 are not applied, apply them first';
  end if;
  if v_loan <= 0 or v_loan >= v_expected_assets then
    raise exception 'the loan amount must be above zero and below the assets of the fund';
  end if;

  select * into v_fund from smsf_funds where user_id = v_uid and is_active;
  if not found then
    raise exception 'no active SMSF fund for this user';
  end if;
  if v_fund.mode <> 'detailed' then
    raise exception 'the fund is not recorded as itemised, this cutover expects an itemised fund';
  end if;
  if exists (select 1 from smsf_liabilities where smsf_fund_id = v_fund.id and is_active) then
    raise exception 'the fund already has liabilities, this cutover was already applied';
  end if;

  select coalesce(sum(value), 0) into v_assets from smsf_holdings where smsf_fund_id = v_fund.id and is_active and currency_code = 'AUD';
  if v_assets <> v_expected_assets then
    raise exception using message = 'the fund assets are ' || v_assets::text || ' but ' || v_expected_assets::text || ' was expected, stop and run P2 again';
  end if;

  select coalesce(array_agg(id), '{}'), coalesce(sum(current_balance), 0) into v_dup_ids, v_dup_total
    from retirement_accounts
    where user_id = v_uid and is_active and owner = 'smsf' and coalesce(master_item_key, '') <> 'smsf';
  if coalesce(cardinality(v_dup_ids), 0) <> v_expected_dup_count or v_dup_total <> v_expected_dup_total then
    raise exception using message = 'expected ' || v_expected_dup_count::text || ' duplicate row(s) worth ' || v_expected_dup_total::text || ' but found ' || coalesce(cardinality(v_dup_ids), 0)::text || ' worth ' || v_dup_total::text || ', stop and run P2 again';
  end if;

  -- Act as this user, so the history records them and the functions see them as the owner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('fhip.cutover_user', v_uid::text, true);

  insert into smsf_liabilities (user_id, smsf_fund_id, liability_name, liability_type, balance, currency_code, notes)
  values (v_uid, v_fund.id, v_loan_name, 'property_loan', v_loan, 'AUD', 'Added by the entity-level cutover pack on the PO instruction of 17-10-2026');

  v_typed := v_fund.summary_balance;
  if v_typed is not null then
    perform smsf_entity_retire_typed_net(v_fund.id, true);
  end if;
  perform smsf_entity_adopt_register_rows(v_fund.id, v_dup_ids, true);

  v_net := smsf_fund_counted_net(v_fund.id);
  if v_net <> v_assets - v_loan then
    raise exception using message = 'the derived net is ' || v_net::text || ' but ' || (v_assets - v_loan)::text || ' was expected, nothing was saved';
  end if;
end
$fn$;

-- Check before you commit: one row, the fund net should equal assets minus the loan, the typed value empty, the duplicate row archived.
select f.fund_name, f.mode, f.summary_balance as typed_net_after, f.detailed_net_value as derived_net,
       (select current_balance from retirement_accounts where id = f.retirement_account_id) as register_mirror,
       (select coalesce(sum(balance), 0) from smsf_liabilities where smsf_fund_id = f.id and is_active) as fund_liabilities,
       (select count(*) from retirement_accounts r where r.user_id = f.user_id and r.is_active and r.owner = 'smsf' and coalesce(r.master_item_key, '') <> 'smsf') as active_duplicate_rows
from smsf_funds f
where f.is_active and f.user_id = current_setting('fhip.cutover_user', true)::uuid;

commit;
