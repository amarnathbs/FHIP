-- II-R12 Wider India Assets -- DEV verification for migration 0092.
-- Run this AFTER pasting and running
-- supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql in
-- full in the DEV project's SQL Editor.
--
-- PART A -- read-only schema checks (spec Stage A step 6). Every row
-- below should show the widened/expected state.

-- A1. price_source column now exists, nullable, with the expected check.
select column_name, is_nullable, data_type
from information_schema.columns
where table_name = 'ii_holding_snapshots' and column_name = 'price_source';
-- EXPECT: one row, is_nullable = YES, data_type = text.

-- A2. transaction_type constraint now includes 'sale' alongside all 22
-- pre-existing values.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'ii_transactions_transaction_type_check';
-- EXPECT: definition text contains 'sale' AND every one of the 22
-- pre-existing values (purchase, sip, redemption, switch_in, switch_out,
-- dividend, reinvestment, transfer, merger, fee, tax, adjustment,
-- stp_in, stp_out, swp, transfer_in, transfer_out, reversal, segregation,
-- unclassified, bonus, split).

-- A3. ii_scheme_tax_classification.basis constraint now includes
-- 'direct_listed_security_rule' alongside all 4 pre-existing values.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'ii_scheme_tax_classification_basis_check';
-- EXPECT: definition text contains 'direct_listed_security_rule' AND all
-- of computed_from_holdings, known_debt_specified_category,
-- unresolved_no_data, unresolved_stale_data.

-- A4. ii_holding_snapshots RLS policy state -- 0092 intentionally
-- contains NO DDL for this (0094 already owns it live). Confirm the
-- policy 0094 created is present and there is exactly one SELECT-only
-- owner policy (no duplicate/orphaned policy from an earlier partial
-- 0092 attempt).
select polname, cmd, qual, with_check
from pg_policies
where tablename = 'ii_holding_snapshots';
-- EXPECT: the same policy set that already exists today (0092 must not
-- have added or changed anything here). If you see a policy named
-- something other than what 0094 created, or two SELECT policies, STOP
-- and report back before proceeding to Part B.

-- PART B -- self-cleaning functional probes (spec Stage A steps 6-8).
-- Uses a throwaway synthetic row inside its own transaction, rolled back
-- at the end -- nothing here is left behind.
begin;

-- B1. 'sale' transaction_type is genuinely accepted (not just present in
-- the constraint text -- prove a real insert succeeds).
do $$
declare
  v_user uuid;
  v_account uuid;
  v_instrument uuid;
begin
  select id into v_user from auth.users limit 1;
  if v_user is null then
    raise notice 'B1 SKIPPED: no auth.users row available to attach a synthetic account to';
    return;
  end if;
  insert into ii_accounts (user_id, country_code, currency_code, account_type, institution_name)
    values (v_user, 'IN', 'INR', 'demat', '0092-DEV-VERIFY-TEMP') returning id into v_account;
  insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status)
    values ('0092-DEV-VERIFY-TEMP-EQUITY', 'equity', 'IN', 'INR', 'provisional') returning id into v_instrument;
  insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
    values (v_user, v_account, v_instrument, 'INR', 'sale', current_date, 5, 100, 500);
  raise notice 'B1 PASS: sale transaction_type accepted';

  -- B2. Invalid transaction_type is still rejected (constraint is not
  -- accidentally permissive).
  begin
    insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
      values (v_user, v_account, v_instrument, 'INR', 'not_a_real_type', current_date, 1, 1, 1);
    raise notice 'B2 FAIL: invalid transaction_type was accepted -- constraint is not enforcing';
  exception when check_violation then
    raise notice 'B2 PASS: invalid transaction_type correctly rejected';
  end;

  -- B3. direct_listed_security_rule basis accepted.
  insert into ii_scheme_tax_classification (instrument_id, classification, basis, domestic_equity_pct, effective_from)
    values (v_instrument, 'equity_oriented', 'direct_listed_security_rule', 100, current_date)
  on conflict do nothing;
  raise notice 'B3 PASS: direct_listed_security_rule basis accepted (or table has no such conflict target -- check for an error above instead)';

  -- B4. Invalid basis is still rejected.
  begin
    insert into ii_scheme_tax_classification (instrument_id, classification, basis, domestic_equity_pct, effective_from)
      values (v_instrument, 'equity_oriented', 'not_a_real_basis', 100, current_date + 1);
    raise notice 'B4 FAIL: invalid basis was accepted -- constraint is not enforcing';
  exception when check_violation then
    raise notice 'B4 PASS: invalid basis correctly rejected';
  end;

  -- B5. price_source accepts a legitimate value and rejects a fabricated one.
  insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, price_source)
    values (v_user, v_account, v_instrument, current_date, 5, 500, 'INR', 'warning', 'manual_entry');
  raise notice 'B5a PASS: price_source=manual_entry accepted';
  begin
    insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, price_source)
      values (v_user, v_account, v_instrument, current_date + 1, 5, 500, 'INR', 'warning', 'fabricated_value');
    raise notice 'B5b FAIL: an invalid price_source was accepted';
  exception when check_violation then
    raise notice 'B5b PASS: invalid price_source correctly rejected';
  end;

  -- B6. Existing mutual-fund path unaffected: legacy transaction_type and
  -- null price_source still work exactly as before.
  insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
    values (v_user, v_account, v_instrument, 'INR', 'redemption', current_date, 2, 100, 200);
  insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status)
    values (v_user, v_account, v_instrument, current_date + 2, 3, 300, 'INR', 'ok');
  raise notice 'B6 PASS: pre-existing redemption transaction_type and null-price_source holding both still work unchanged';
end $$;

rollback; -- B-series is entirely self-cleaning -- nothing above is kept.

-- PART C -- confirm the rollback actually left no residue.
select count(*) as should_be_zero from ii_accounts where institution_name = '0092-DEV-VERIFY-TEMP';
select count(*) as should_be_zero from ii_instruments where instrument_name = '0092-DEV-VERIFY-TEMP-EQUITY';
