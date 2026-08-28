-- Production verification for migration 0092 (II-R12 Wider India Assets).
-- Run AFTER applying 01_0092_ii_r12_wider_india_assets_foundation.sql.
--
-- Follows this project's established pattern: a single
-- `returns table(step text, outcome text, detail text)` function, invoked
-- inside `begin; ... rollback;` so every write it performs is undone
-- automatically -- nothing in Part B/C survives, even if you forget the
-- explicit cleanup checks at the bottom (defence in depth: an intentional
-- ROLLBACK, not just app-level cleanup calls).
--
-- Structure:
--   PART A -- schema checks (read-only, no transaction needed)
--   PART B -- security checks (0094 unchanged + forgery/access probes)
--   PART C -- existing-investments regression (R4/R5/R6/R9/R10/R12 paths
--             this migration must not disturb)
--   PART D -- cleanup confirmation (explicit re-query proving 0 residue)
--
-- This is a PREPARED artifact. It has not been executed against production
-- by any agent -- no production credentials exist in this environment. Run
-- it yourself (or hand it to the orchestrating session) after 0092 is live.
-- =============================================================================


-- =============================================================================
-- PART A -- schema checks (read-only).
-- =============================================================================

-- A1. price_source column now exists, nullable, with the expected 4-value
--     check constraint (plus null).
select column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'ii_holding_snapshots' and column_name = 'price_source';
-- EXPECT: 1 row, is_nullable = 'YES', data_type = 'text'.

-- A2. transaction_type constraint now accepts 'sale' AND all 22 legacy
--     values are still present (this migration is additive-only).
select pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'ii_transactions'::regclass and conname = 'ii_transactions_transaction_type_check';
-- EXPECT: value list contains all of: purchase, sip, redemption, switch_in,
-- switch_out, dividend, reinvestment, transfer, merger, fee, tax,
-- adjustment, stp_in, stp_out, swp, transfer_in, transfer_out, reversal,
-- segregation, unclassified, bonus, split (22 legacy values) PLUS 'sale'
-- (23 total).

-- A3. basis constraint now accepts 'direct_listed_security_rule' AND all 4
--     legacy values are still present.
select pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'ii_scheme_tax_classification'::regclass and conname = 'ii_scheme_tax_classification_basis_check';
-- EXPECT: value list contains computed_from_holdings,
-- known_debt_specified_category, unresolved_no_data, unresolved_stale_data
-- (4 legacy values) PLUS direct_listed_security_rule (5 total).


-- =============================================================================
-- PART B -- security checks (0094 must remain the sole authoritative policy;
-- same-user forgery blocked; cross-user access blocked; trusted service
-- path still works). Synthetic data only, self-cleaning.
-- =============================================================================

create or replace function verify_0092_security()
returns table(step text, outcome text, detail text) as $$
declare
  v_user_a       uuid := gen_random_uuid();
  v_user_b       uuid := gen_random_uuid();
  v_account_a    uuid;
  v_instrument   uuid;
  v_snapshot_a   uuid;
  v_before_value numeric;
  v_after_value  numeric;
  v_rows_seen_by_b integer;
  v_invalid_rejected boolean := false;
begin
  -- SETUP -------------------------------------------------------------------
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
    values
      (v_user_a, 'authenticated', 'authenticated', '__r12_0092_verify_a__@fhip-test.invalid', crypt('x', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', ''),
      (v_user_b, 'authenticated', 'authenticated', '__r12_0092_verify_b__@fhip-test.invalid', crypt('x', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '')
    on conflict (id) do nothing;
    step := 'SETUP: synthetic auth users'; outcome := 'OK'; detail := null; return next;
  exception when others then
    step := 'SETUP: synthetic auth users'; outcome := 'FAILED'; detail := sqlerrm; return next;
    return;
  end;

  select id into v_instrument from ii_instruments limit 1;
  if v_instrument is null then
    step := 'SETUP: instrument lookup'; outcome := 'SKIPPED';
    detail := 'no ii_instruments row exists to reference -- rest of this probe cannot run; rely on Part A''s static schema checks and the standalone 0094 policy check in docs/production-apply/ii-holding-snapshots-hotfix-0094/02_production_verification.sql instead';
    return next;
    return;
  end if;

  insert into ii_accounts (user_id, provider, account_type)
  values (v_user_a, 'manual_entry', 'demat')
  returning id into v_account_a;
  step := 'SETUP: synthetic account'; outcome := 'OK'; detail := null; return next;

  insert into ii_holding_snapshots (user_id, account_id, instrument_id, value, units, as_of_date, price_source)
  values (v_user_a, v_account_a, v_instrument, 15000, 100, current_date, 'manual_entry')
  returning id, value into v_snapshot_a, v_before_value;
  step := 'SETUP: synthetic holding (user A, price_source=manual_entry)'; outcome := 'OK';
  detail := 'value=' || v_before_value; return next;

  -- B1. price_source accepts all 4 documented values + null; rejects invalid.
  begin
    update ii_holding_snapshots set price_source = 'statement_price' where id = v_snapshot_a;
    update ii_holding_snapshots set price_source = 'admin_reference' where id = v_snapshot_a;
    update ii_holding_snapshots set price_source = 'certified_market_data' where id = v_snapshot_a;
    update ii_holding_snapshots set price_source = null where id = v_snapshot_a;
    update ii_holding_snapshots set price_source = 'manual_entry' where id = v_snapshot_a;
    step := 'B1: price_source accepts all 4 legacy-compatible values + null'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B1: price_source value acceptance'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  begin
    update ii_holding_snapshots set price_source = '__not_a_real_source__' where id = v_snapshot_a;
    step := 'B2: invalid price_source rejected'; outcome := 'FAILED (write succeeded, should have been rejected)'; detail := null; return next;
  exception when others then
    v_invalid_rejected := true;
    step := 'B2: invalid price_source rejected'; outcome := 'PASS'; detail := sqlerrm; return next;
  end;

  -- B3. 'sale' transaction_type accepted (the one new value 0092 adds).
  begin
    insert into ii_transactions (user_id, account_id, instrument_id, transaction_type, transaction_date, units, amount)
    values (v_user_a, v_account_a, v_instrument, 'sale', current_date, 10, 1500);
    step := 'B3: transaction_type=sale accepted'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B3: transaction_type=sale accepted'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  -- B4. 'direct_listed_security_rule' basis accepted.
  begin
    insert into ii_scheme_tax_classification (instrument_id, basis)
    values (v_instrument, 'direct_listed_security_rule')
    on conflict (instrument_id) do update set basis = excluded.basis;
    step := 'B4: basis=direct_listed_security_rule accepted'; outcome := 'PASS'; detail := null; return next;
  exception when others then
    step := 'B4: basis=direct_listed_security_rule accepted'; outcome := 'FAILED (adjust conflict target to this table''s real unique key and rerun)'; detail := sqlerrm; return next;
  end;

  -- B5. 0094 is still the sole authoritative policy on ii_holding_snapshots
  --     (SELECT-only for owner; no INSERT/UPDATE/DELETE for authenticated).
  declare
    v_policy_count integer;
    v_nonselect_count integer;
  begin
    select count(*) into v_policy_count from pg_policies where tablename = 'ii_holding_snapshots';
    select count(*) into v_nonselect_count from pg_policies where tablename = 'ii_holding_snapshots' and cmd <> 'SELECT';
    step := 'B5: ii_holding_snapshots policy count / non-SELECT count';
    outcome := case when v_policy_count = 1 and v_nonselect_count = 0 then 'PASS' else 'FAILED' end;
    detail := 'policy_count=' || v_policy_count || ', non_select_count=' || v_nonselect_count || ' (expect 1 / 0 -- 0094 remains sole owner, 0092 must not have added a second policy)';
    return next;
  end;

  -- B6. Same-user authoritative forgery still blocked at the app layer
  --     (this SQL session runs with elevated privileges and bypasses RLS by
  --     design -- Part B5's pg_policies inspection above is the
  --     authoritative structural proof; this step is a documentation
  --     placeholder pointing at the real live-REST reproduction).
  step := 'B6: same-user forgery / cross-user access / trusted-service-write';
  outcome := 'SEE SEPARATE LIVE-REST CHECK';
  detail := 'SQL-editor sessions run as a privileged role and cannot exercise RLS as an authenticated user would -- re-run scripts/r12_terminal_0092_rest_verification.mjs (or scripts/r12_live_dev_verification.mjs LIVE-R12-02) pointed at production credentials for the real same-user-PATCH-forgery-blocked / cross-user-404-or-empty / service-role-write-allowed proof, mirroring exactly what was already reproduced against DEV.';
  return next;

  return;
end;
$$ language plpgsql;

begin;
select * from verify_0092_security();
rollback;

drop function if exists verify_0092_security();


-- =============================================================================
-- PART C -- existing-investments regression (MF positions untouched; R4/R5/
-- R6/R9/R10/R12 read paths still functioning). Read-only counts only --
-- run OUTSIDE any transaction, compare to the Part 6 baseline you recorded
-- in 02_production_precheck.sql.
-- =============================================================================

select
  (select count(*) from ii_transactions) as ii_transactions_count,
  (select count(*) from ii_holding_snapshots) as ii_holding_snapshots_count,
  (select count(*) from ii_scheme_tax_classification) as ii_scheme_tax_classification_count,
  (select count(*) from ii_instruments) as ii_instruments_count;
-- EXPECT: all four numbers byte-identical to the precheck baseline (0092
-- adds zero rows to any of these tables by itself -- it only widens two
-- constraints and adds one nullable column).

-- Spot-check: at least one pre-existing mutual-fund holding/transaction is
-- still readable and unchanged in shape (proves this migration did not
-- alter existing rows, only permitted new values).
select id, transaction_type, amount, units
from ii_transactions
where transaction_type in ('purchase', 'redemption', 'switch_in', 'switch_out')
order by transaction_date desc
limit 5;
-- EXPECT: pre-existing mutual-fund transactions still present, values
-- unchanged from before the migration.


-- =============================================================================
-- PART D -- cleanup confirmation. The verify_0092_security() probe above
-- ran inside begin;...rollback; so nothing it wrote should have survived.
-- Confirm explicitly:
-- =============================================================================

select count(*) as leaked_synthetic_users
from auth.users
where email in ('__r12_0092_verify_a__@fhip-test.invalid', '__r12_0092_verify_b__@fhip-test.invalid');
-- EXPECT: 0.

select count(*) as leaked_synthetic_accounts
from ii_accounts
where provider = 'manual_entry'
  and user_id::text like '%'
  and created_at > now() - interval '1 hour'
  and user_id not in (select id from auth.users where email not like '__r12_0092_verify%');
-- This query is intentionally broad -- if it returns anything unexpected,
-- manually inspect ii_accounts/ii_holding_snapshots/ii_transactions created
-- in the last hour rather than trusting the filter blindly. EXPECT: 0 (the
-- ROLLBACK above should have made this moot already).
