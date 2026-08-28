-- II-R12 Wider India Assets -- DEV verification for migration 0092.
-- Run this AFTER pasting and running
-- supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql in
-- full in the DEV project's SQL Editor.
--
-- REVISION (2026-08-27, terminal certification pass): Part B was rewritten
-- from `do $$ ... raise notice ... $$` blocks to the project's established
-- `create or replace function ... returns table(step text, outcome text,
-- detail text)` + `begin; select * from fn(); rollback;` pattern (see
-- docs/production-apply/goal-funding-sources-hotfix-0095/02_production_verification.sql
-- and docs/production-apply/ii-holding-snapshots-hotfix-0094/02_production_verification.sql
-- for precedent). Reason: the Product Owner's Supabase Studio SQL Editor has
-- no visible Notices panel, so a `raise notice` produces NO output the human
-- running this script can see or paste back -- the original version of this
-- file would have appeared to run successfully while reporting nothing.
-- `return next` rows ARE returned as an ordinary query result set and will
-- render as a table in the SQL Editor. No check's substance changed; every
-- probe below is functionally identical to the prior draft.
--
-- This rewrite also fixed a second, independent, real bug found by actually
-- EXECUTING this script end-to-end against a fresh PGlite (real Postgres)
-- rebuild for the first time (the prior draft was apparently never run
-- against a real schema before handoff): B3/B4 referenced a column
-- `effective_from` on `ii_scheme_tax_classification` that does not exist.
-- The table's real NOT NULL columns are `engine_version` (text, no default)
-- and `computed_at` (timestamptz, defaults to now()); `disclosure_date` is
-- the actual nullable date column, unused by these two probes. Fixed to
-- supply `engine_version` instead. A THIRD, unrelated, pre-existing bug was
-- also found the same way: B6's legacy-path probe used `quality_status =
-- 'ok'`, which is not a valid value for `ii_holding_snapshots`'s own
-- (pre-R12, unrelated to 0092) check constraint -- the real allowed values
-- are `certified` / `warning` / `incomplete`. Fixed to `warning` (matching
-- the other probes in this same file). Independently re-run after both
-- fixes: all 9 steps (SETUP x3, B1-B6) report PASS/OK on a fresh full-chain
-- rebuild including 0092, and Part C's two residue counts both come back 0.
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
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'ii_holding_snapshots';
-- EXPECT: exactly one row -- "read own ii_holding_snapshots", cmd SELECT,
-- qual (auth.uid() = user_id), with_check null. 0092 must not have added
-- or changed anything here. If you see a policy named something other than
-- this, or more than one row, STOP and report back before proceeding to
-- Part B.

-- =============================================================================
-- PART B -- self-cleaning behavioural checks (spec Stage A steps 6-8).
-- Uses throwaway synthetic rows inside a transaction that always rolls back
-- -- nothing here is left behind. Results come back as an ordinary result
-- set (one row per step), NOT as raise notice output.
-- =============================================================================

create or replace function verify_0092_activation()
returns table(step text, outcome text, detail text) as $$
declare
  v_user       uuid;
  v_account    uuid;
  v_instrument uuid;
begin
  select id into v_user from auth.users limit 1;
  if v_user is null then
    step := 'SETUP: locate an auth.users row'; outcome := 'SKIPPED';
    detail := 'no auth.users row available to attach a synthetic account to -- cannot run Part B';
    return next;
    return;
  end if;
  step := 'SETUP: locate an auth.users row'; outcome := 'OK'; detail := v_user::text; return next;

  insert into ii_accounts (user_id, country_code, currency_code, account_type, institution_name)
    values (v_user, 'IN', 'INR', 'demat', '0092-DEV-VERIFY-TEMP')
    returning id into v_account;
  step := 'SETUP: synthetic ii_accounts row'; outcome := 'OK'; detail := v_account::text; return next;

  insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status)
    values ('0092-DEV-VERIFY-TEMP-EQUITY', 'equity', 'IN', 'INR', 'provisional')
    returning id into v_instrument;
  step := 'SETUP: synthetic ii_instruments row'; outcome := 'OK'; detail := v_instrument::text; return next;

  -- B1. 'sale' transaction_type is genuinely accepted (not just present in
  -- the constraint text -- prove a real insert succeeds).
  begin
    insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
      values (v_user, v_account, v_instrument, 'INR', 'sale', current_date, 5, 100, 500);
    step := 'B1: sale transaction_type accepted'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B1: sale transaction_type accepted'; outcome := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- B2. Invalid transaction_type is still rejected (constraint is not
  -- accidentally permissive).
  begin
    insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
      values (v_user, v_account, v_instrument, 'INR', 'not_a_real_type', current_date, 1, 1, 1);
    step := 'B2: invalid transaction_type rejected'; outcome := 'FAIL'; detail := 'insert succeeded -- constraint is not enforcing'; return next;
  exception when check_violation then
    step := 'B2: invalid transaction_type rejected'; outcome := 'PASS'; detail := sqlerrm; return next;
  end;

  -- B3. direct_listed_security_rule basis accepted.
  begin
    insert into ii_scheme_tax_classification (instrument_id, classification, basis, domestic_equity_pct, engine_version)
      values (v_instrument, 'equity_oriented', 'direct_listed_security_rule', 100, '0092-dev-verify');
    step := 'B3: direct_listed_security_rule basis accepted'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B3: direct_listed_security_rule basis accepted'; outcome := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- B4. Invalid basis is still rejected.
  begin
    insert into ii_scheme_tax_classification (instrument_id, classification, basis, domestic_equity_pct, engine_version)
      values (v_instrument, 'equity_oriented', 'not_a_real_basis', 100, '0092-dev-verify');
    step := 'B4: invalid basis rejected'; outcome := 'FAIL'; detail := 'insert succeeded -- constraint is not enforcing'; return next;
  exception when check_violation then
    step := 'B4: invalid basis rejected'; outcome := 'PASS'; detail := sqlerrm; return next;
  end;

  -- B5a. price_source accepts a legitimate value.
  begin
    insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, price_source)
      values (v_user, v_account, v_instrument, current_date, 5, 500, 'INR', 'warning', 'manual_entry');
    step := 'B5a: price_source=manual_entry accepted'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B5a: price_source=manual_entry accepted'; outcome := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- B5b. price_source rejects a fabricated/unrecognised value.
  begin
    insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, price_source)
      values (v_user, v_account, v_instrument, current_date + 1, 5, 500, 'INR', 'warning', 'fabricated_value');
    step := 'B5b: invalid price_source rejected'; outcome := 'FAIL'; detail := 'insert succeeded -- constraint is not enforcing'; return next;
  exception when check_violation then
    step := 'B5b: invalid price_source rejected'; outcome := 'PASS'; detail := sqlerrm; return next;
  end;

  -- B6. Existing mutual-fund path unaffected: legacy transaction_type and
  -- null price_source still work exactly as before.
  begin
    insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount)
      values (v_user, v_account, v_instrument, 'INR', 'redemption', current_date, 2, 100, 200);
    insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status)
      values (v_user, v_account, v_instrument, current_date + 2, 3, 300, 'INR', 'warning');
    step := 'B6: legacy redemption + null price_source still work'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B6: legacy redemption + null price_source still work'; outcome := 'FAIL'; detail := sqlerrm; return next;
  end;

  return;
end;
$$ language plpgsql;

begin;
select * from verify_0092_activation();
rollback; -- everything above is entirely self-cleaning -- nothing is kept.

drop function if exists verify_0092_activation();

-- PART C -- confirm the rollback actually left no residue.
select count(*) as should_be_zero from ii_accounts where institution_name = '0092-DEV-VERIFY-TEMP';
select count(*) as should_be_zero from ii_instruments where instrument_name = '0092-DEV-VERIFY-TEMP-EQUITY';
-- EXPECT: both 0.
