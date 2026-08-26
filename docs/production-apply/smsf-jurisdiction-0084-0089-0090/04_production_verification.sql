-- =============================================================================
-- Production verification script for 0084 / 0089 / 0090 (SMSF Summary/Detailed
-- Holdings + Jurisdiction Applicability Foundation).
--
-- HOW TO USE: run this in the production Supabase SQL Editor AFTER applying
-- 01_0084_geo_jurisdiction_smsf.sql, 02_0089_smsf_switch_to_summary.sql, and
-- 03_0090_smsf_current_balance_integrity_guard.sql, in that order. Paste the
-- full output back for the record.
--
-- This script is split into two parts:
--   PART A -- pure read-only schema/catalogue checks. Safe, no side effects,
--             touches no rows.
--   PART B -- live behavioural checks (the 0090 guard's rejection behaviour,
--             and the AU/IN jurisdiction gate) that require an actual INSERT/
--             UPDATE attempt to prove the trigger fires. Wrapped in a single
--             transaction that ends in ROLLBACK, so nothing is persisted
--             regardless of outcome -- no real customer data is created,
--             touched, or left behind. Every RAISE NOTICE line is the
--             evidence; read them in the SQL Editor's "Messages"/output pane
--             after running, since ROLLBACK means no rows will appear in a
--             SELECT afterwards (that is the point).
--
-- This script was authored by an agent with NO ability to execute SQL
-- against production; it has been validated only against DEV (where the
-- equivalent PGlite/live-DEV certification scripts pass 73/73 and 8/8 -- see
-- scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs and
-- scripts/smsf_0090_live_dev_verification.mjs in the smsf-ui-completion
-- branch). A human must run this in production and confirm the results.
-- =============================================================================


-- =============================================================================
-- PART A -- read-only schema/catalogue presence checks
-- =============================================================================

-- A1. Tables exist
select
  (to_regclass('public.smsf_funds') is not null)        as smsf_funds_exists,
  (to_regclass('public.smsf_fund_members') is not null) as smsf_fund_members_exists,
  (to_regclass('public.smsf_holdings') is not null)      as smsf_holdings_exists;
-- EXPECT: all three true.

-- A2. RLS enabled on all three new tables
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('smsf_funds', 'smsf_fund_members', 'smsf_holdings')
  and relnamespace = 'public'::regnamespace;
-- EXPECT: relrowsecurity = true for all three rows.

-- A3. country_applicability column on master_financial_items (GEO-1)
select column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'public' and table_name = 'master_financial_items'
  and column_name = 'country_applicability';
-- EXPECT: one row, udt_name = '_bpchar' (char(2)[]).

-- A4. SMSF catalogue item is AU-restricted, nothing else was accidentally restricted
select item_key, country_applicability
from master_financial_items
where category = 'retirement' and country_applicability is not null;
-- EXPECT: exactly one row -- item_key = 'smsf', country_applicability = {AU}.

-- A5. Functions exist (0084 + 0089 + 0090)
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'retirement_accounts_smsf_au_gate',
    'smsf_funds_validate_retirement_link',
    'smsf_holdings_total_aud',
    'smsf_linked_loans_total_aud',
    'smsf_compute_detailed_net_value',
    'smsf_recompute_fund',
    'trg_smsf_funds_sync_summary_balance',
    'smsf_create_fund',
    'smsf_switch_to_detailed',
    'trg_smsf_recompute_from_holding',
    'trg_smsf_recompute_from_link',
    'trg_smsf_recompute_from_liability',
    'smsf_switch_to_summary',
    'retirement_accounts_smsf_balance_guard'
  )
order by proname;
-- EXPECT: all 14 names present (some may legitimately be overloaded -- more
-- than 14 rows is fine, fewer than 14 distinct proname values is a problem).

-- A6. Triggers exist and are enabled
select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname in (
    'trg_retirement_accounts_smsf_au_gate',
    'trg_smsf_funds_validate_link',
    'trg_smsf_funds_sync_summary',
    'trg_smsf_holdings_recompute',
    'trg_pll_smsf_recompute',
    'trg_liabilities_smsf_recompute',
    'trg_retirement_accounts_smsf_balance_guard'
  )
order by tgname;
-- EXPECT: 7 rows, tgenabled = 'O' (origin, i.e. enabled) for all.

-- A7. Existing "0 rows / $0" contribution-pollution invariant (spec-critical,
-- pre-existing, must remain true after these migrations land -- this is a
-- read-only sanity check, not something these migrations change)
select count(*) as contribution_rows_with_smsf_semantics
from smsf_holdings
where holding_type not in ('cash', 'listed_security', 'managed_fund', 'property', 'other');
-- EXPECT: 0 (the holding_type CHECK constraint should make this structurally
-- impossible; 0 here is the expected/only valid answer on a freshly-applied,
-- still-empty table, and should stay 0 going forward).

select count(*) as retirement_accounts_touched_unexpectedly
from retirement_accounts
where master_item_key <> 'smsf' and updated_at > (select max(applied_at) from supabase_migrations.schema_migrations where version = '0084');
-- Informational only -- if your project does not track applied_at in
-- supabase_migrations.schema_migrations, skip this query; it is not
-- essential evidence, just a convenience cross-check.


-- =============================================================================
-- PART B -- live behavioural checks (self-cleaning: wrapped in a transaction
-- that always ends in ROLLBACK). Run this whole block as one statement/paste.
-- =============================================================================

do $$
declare
  v_synthetic_au_user  uuid := gen_random_uuid();
  v_synthetic_in_user  uuid := gen_random_uuid();
  v_fund_id            uuid;
  v_err                text;
begin
  raise notice '--- SETUP: two synthetic users, never committed (this whole DO block runs inside the outer transaction, which this script rolls back at the end) ---';

  insert into user_profiles (id, country_of_residence, display_name)
  values (v_synthetic_au_user, 'AU', '__smsf_prod_verify_au__')
  on conflict (id) do nothing;

  insert into user_profiles (id, country_of_residence, display_name)
  values (v_synthetic_in_user, 'IN', '__smsf_prod_verify_in__')
  on conflict (id) do nothing;

  -- B1. Jurisdiction gate: AU resident CAN create an SMSF retirement_accounts row
  begin
    insert into retirement_accounts (user_id, master_item_key, account_name, current_balance, currency_code)
    values (v_synthetic_au_user, 'smsf', '__prod_verify_au_smsf__', 100000, 'AUD')
    returning id into v_fund_id;
    raise notice 'B1 PASS: AU resident SMSF creation succeeded (row id %)', v_fund_id;
  exception when others then
    raise notice 'B1 FAIL (unexpected rejection for an AU resident): %', sqlerrm;
  end;

  -- B2. Jurisdiction gate: IN resident CANNOT create an SMSF retirement_accounts row
  begin
    insert into retirement_accounts (user_id, master_item_key, account_name, current_balance, currency_code)
    values (v_synthetic_in_user, 'smsf', '__prod_verify_in_smsf__', 100000, 'AUD');
    raise notice 'B2 FAIL: IN resident SMSF creation should have been rejected but succeeded';
  exception when others then
    get stacked diagnostics v_err = message_text;
    raise notice 'B2 PASS: IN resident SMSF creation correctly rejected (%)', v_err;
  end;

  -- B3. GUARD 0090: direct UPDATE of an SMSF row's current_balance is rejected
  if v_fund_id is not null then
    begin
      update retirement_accounts set current_balance = 999999 where id = v_fund_id;
      raise notice 'B3 FAIL: direct current_balance UPDATE on an SMSF row should have been rejected but succeeded';
    exception when others then
      get stacked diagnostics v_err = message_text;
      raise notice 'B3 PASS: direct current_balance UPDATE correctly rejected (%)', v_err;
    end;

    -- B4. NEGATIVE CONTROL: a non-balance column on the same SMSF row remains editable
    begin
      update retirement_accounts set account_name = '__prod_verify_au_smsf_renamed__' where id = v_fund_id;
      raise notice 'B4 PASS: non-balance column edit on the SMSF row succeeded (guard is narrow, as designed)';
    exception when others then
      raise notice 'B4 FAIL (guard is over-broad -- blocked a non-balance edit): %', sqlerrm;
    end;
  else
    raise notice 'B3/B4 SKIPPED: no fund id from B1 to test against';
  end if;

  raise notice '--- CLEANUP: rolling back the entire transaction now -- nothing above is persisted ---';
  raise exception 'INTENTIONAL_ROLLBACK_DO_NOT_TREAT_AS_A_REAL_ERROR -- this forces the block to roll back so no synthetic rows survive';
exception when others then
  if sqlerrm like 'INTENTIONAL_ROLLBACK%' then
    raise notice 'Rollback triggered on purpose -- all synthetic rows above have been discarded.';
  else
    raise notice 'DO block ended on an unexpected error (see message): %', sqlerrm;
  end if;
end $$;

-- After the DO block above raises, Postgres will show the DO block itself as
-- "successful" (the exception was caught inside the block) but nothing was
-- committed because everything happened inside this script's implicit
-- transaction and the raise exception + outer catch guarantees a clean exit.
-- If your SQL Editor auto-commits per statement rather than treating the
-- whole pasted script as one transaction, wrap the entire PART B block
-- explicitly in BEGIN; ... (the DO block) ... ROLLBACK; instead.

-- Confirm no synthetic rows survived:
select count(*) as leaked_synthetic_users
from user_profiles
where display_name in ('__smsf_prod_verify_au__', '__smsf_prod_verify_in__');
-- EXPECT: 0. If this is not 0, manually delete the two synthetic user_profiles
-- rows (and any retirement_accounts rows referencing them) before closing
-- this out -- do not leave synthetic data in production.
