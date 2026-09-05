-- =============================================================================
-- DEV verification script for migration 0129 (G5B — Generic Universal-Module
-- Write Enablement).
--
-- HOW TO USE
-- ----------
-- Run each numbered PART as its own execution in the DEV Supabase project's
-- SQL Editor (Part B is three statements that must run in the SAME order,
-- back to back — statement B1 creates a function, B2 calls it, B3 drops it).
-- Paste every result grid back. This script is SELF-CLEANING: Part B creates
-- synthetic auth.users rows (clearly named '_tmp_g5b_verify_*@fhip-verify.invalid')
-- and deletes them again inside the same function call, and drops its own
-- helper function in B3. Nothing is left behind in a normal run.
--
-- This follows the exact pattern established by the FDH-2/FDH-12/G3 (0127)
-- DEV verifications in this repo: object-presence checks are independent
-- single-statement SELECTs, and every behavioral check is a result ROW
-- rather than a RAISE NOTICE (Studio's SQL Editor has no Notices panel).
-- =============================================================================


-- =============================================================================
-- PART A — are the objects migration 0129 declares actually present?
-- =============================================================================

-- A1. The manifest table exists with exactly 9 rows in the expected shape.
select
  'A1. mcc_generic_write_capabilities has exactly 9 rows' as check_name,
  case when count(*) = 9 then 'PASS' else 'FAIL' end as result,
  count(*)::text as detail
from public.mcc_generic_write_capabilities;

-- A2. The 9 rows have exactly the expected per-cell values.
select
  'A2. manifest cell values' as check_name,
  table_name,
  operation,
  generic_write_allowed,
  case
    when table_name in ('income_sources','expense_items','insurance_policies') and operation in ('INSERT','UPDATE') and generic_write_allowed = true then 'PASS'
    when table_name in ('income_sources','expense_items','insurance_policies') and operation = 'DELETE' and generic_write_allowed = false then 'PASS'
    else 'FAIL'
  end as result
from public.mcc_generic_write_capabilities
order by table_name, operation;
-- EXPECT: 9 rows, all PASS. income_sources/expense_items/insurance_policies x
-- INSERT/UPDATE = true; x DELETE = false.

-- A3. No row exists for any table outside the three certified ones (default-deny).
select
  'A3. no manifest rows outside the 3 certified tables' as check_name,
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  count(*)::text as detail
from public.mcc_generic_write_capabilities
where table_name not in ('income_sources', 'expense_items', 'insurance_policies');

-- A4. The new functions exist, both SECURITY DEFINER.
select
  'A4. functions present' as check_name,
  p.proname as function_name,
  case when p.prosecdef then 'security definer' else 'security invoker' end as security
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_write_permitted', 'enforce_write_permitted_g5b')
order by p.proname;
-- EXPECT: 2 rows, both security definer.

-- A5. is_country_confirmed() itself is UNCHANGED (still exists, still the
-- original 0104/0105 definition — spot check its source text contains no
-- reference to the new manifest table, proving it was not touched).
select
  'A5. is_country_confirmed() body does not reference the new manifest (untouched)' as check_name,
  case when prosrc not ilike '%mcc_generic_write_capabilities%' then 'PASS' else 'FAIL' end as result
from pg_proc
where proname = 'is_country_confirmed';

-- A6. Triggers on the three certified tables now call the new function, for
-- all three operations combined into one trigger (before insert or update or
-- delete).
select
  'A6. new trigger present on the 3 certified tables' as check_name,
  c.relname as table_name,
  t.tgname as trigger_name,
  p.proname as calls_function,
  t.tgenabled as enabled_flag,
  pg_get_triggerdef(t.oid) as full_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal
  and c.relname in ('income_sources', 'expense_items', 'insurance_policies')
order by c.relname;
-- EXPECT: 3 rows, trigger_name = trg_g5b_write_permitted, calls_function =
-- enforce_write_permitted_g5b, enabled_flag = 'O', and full_definition shows
-- BEFORE INSERT OR UPDATE OR DELETE. The OLD trg_enforce_country_confirmed
-- must be ABSENT on these three tables (this query would show it if present
-- — it isn't filtered out).

-- A7. Every OTHER table's trigger is untouched — spot-check assets and
-- households (one from the original 8, one from the 69-table 0105 batch).
select
  'A7. spot-check: assets/households still use the ORIGINAL trigger, untouched' as check_name,
  c.relname as table_name,
  t.tgname as trigger_name,
  p.proname as calls_function,
  t.tgenabled as enabled_flag
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal
  and c.relname in ('assets', 'households', 'liabilities', 'investments', 'retirement_accounts', 'user_goals')
order by c.relname;
-- EXPECT: 6 rows (one per table), ALL trigger_name = trg_enforce_country_confirmed,
-- calls_function = enforce_country_confirmed (the ORIGINAL, untouched
-- function), enabled_flag = 'O'. None of these should show
-- trg_g5b_write_permitted or enforce_write_permitted_g5b.

-- A8. Grants: authenticated can execute is_write_permitted(); the manifest
-- table itself grants nothing to authenticated/anon.
select
  'A8a. is_write_permitted() grant' as check_name,
  p.proname as function_name,
  r.rolname as grantee
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(p.proacl) a on true
join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and p.proname = 'is_write_permitted' and a.privilege_type = 'EXECUTE';
-- EXPECT: at least one row with grantee = authenticated.

select
  'A8b. mcc_generic_write_capabilities has no authenticated/anon grants' as check_name,
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  count(*)::text as detail
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'mcc_generic_write_capabilities'
  and grantee in ('authenticated', 'anon');


-- =============================================================================
-- PART B — live behavioral proof, self-contained and self-cleaning.
-- Run B1, then B2, then B3, in that order.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- B1. Create the helper function.
-- ---------------------------------------------------------------------------
create or replace function public._tmp_g5b_verify_0129()
returns table(seq int, check_name text, result text, detail text)
language plpgsql
as $$
declare
  v_au uuid := gen_random_uuid();   -- FULL control (AU, confirmed)
  v_gb uuid := gen_random_uuid();   -- GENERIC (GB, confirmed) — the subject of G5B
  v_gb_unconf uuid := gen_random_uuid(); -- GENERIC, NOT confirmed — must stay blocked
  v_n int;
begin
  insert into auth.users(id, email) values
    (v_au, '_tmp_g5b_verify_au@fhip-verify.invalid'),
    (v_gb, '_tmp_g5b_verify_gb@fhip-verify.invalid'),
    (v_gb_unconf, '_tmp_g5b_verify_gb_unconf@fhip-verify.invalid');

  update public.user_profiles
    set onboarding_completed = true,
        country_of_residence = 'AU', country_confirmed_at = now(), country_source = 'USER_CONFIRMED'
    where user_id = v_au;
  update public.user_profiles
    set onboarding_completed = true,
        country_of_residence = 'GB', country_confirmed_at = now(), country_source = 'USER_CONFIRMED',
        generic_disclosure_version = 'v1', generic_disclosure_acknowledged_at = now(), generic_disclosure_country = 'GB'
    where user_id = v_gb;
  update public.user_profiles
    set onboarding_completed = true,
        country_of_residence = 'GB', country_confirmed_at = null
    where user_id = v_gb_unconf;

  seq := 0; check_name := 'setup: synthetic users created (au confirmed, gb confirmed, gb unconfirmed)';
  result := 'INFO'; detail := 'au=' || v_au || ' gb=' || v_gb || ' gb_unconf=' || v_gb_unconf;
  return next;

  perform set_config('request.jwt.claims', json_build_object('sub', v_au, 'role', 'authenticated')::text, true);

  -- 1. AU (FULL, confirmed) can still INSERT into all 3 certified tables — no regression.
  begin
    insert into public.income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
      values (v_au, '_tmp_g5b_verify', 'salary', 100, 'monthly', 'AUD', true);
    insert into public.expense_items(user_id, expense_name, expense_category, amount, frequency, currency_code, is_active)
      values (v_au, '_tmp_g5b_verify', 'other', 50, 'monthly', 'AUD', true);
    insert into public.insurance_policies(user_id, policy_name, cover_type, cover_amount, premium, premium_frequency, currency_code)
      values (v_au, '_tmp_g5b_verify', 'life', 100000, 20, 'monthly', 'AUD');
    seq := 1; check_name := 'AU (FULL) can INSERT into income_sources/expense_items/insurance_policies — no regression';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 1; check_name := 'AU (FULL) can INSERT into income_sources/expense_items/insurance_policies — no regression';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 2. AU (FULL) can still INSERT into assets (a table G5B does NOT touch) — no regression.
  begin
    insert into public.assets(user_id, asset_name, asset_type, current_value, country_code, currency_code)
      values (v_au, '_tmp_g5b_verify', 'other', 1000, 'AU', 'AUD');
    seq := 2; check_name := 'AU (FULL) can still INSERT into assets (untouched table) — no regression';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 2; check_name := 'AU (FULL) can still INSERT into assets (untouched table) — no regression';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 3. AU (FULL) can still UPDATE and (soft-)DELETE their own income_sources row.
  begin
    update public.income_sources set amount = 200 where user_id = v_au and source_name = '_tmp_g5b_verify';
    update public.income_sources set is_active = false where user_id = v_au and source_name = '_tmp_g5b_verify';
    seq := 3; check_name := 'AU (FULL) can UPDATE and archive(UPDATE) their own income_sources row — no regression';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 3; check_name := 'AU (FULL) can UPDATE and archive(UPDATE) their own income_sources row — no regression';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 4. AU (FULL) raw literal DELETE on income_sources: DELETE coverage on
  -- this table is NOT new (migration 0108 already made
  -- enforce_country_confirmed()'s trigger TG_OP-aware, before insert or
  -- update or delete, well before G5B) — this proves the SWAP to
  -- is_write_permitted() preserves that existing coverage for a FULL user,
  -- since is_write_permitted() delegates unconditionally to
  -- is_country_confirmed() for them regardless of operation or manifest
  -- content.
  begin
    delete from public.income_sources where user_id = v_au and source_name = '_tmp_g5b_verify';
    seq := 4; check_name := 'AU (FULL) raw literal DELETE on income_sources still succeeds (pre-existing 0108 coverage, preserved by the 0129 swap)';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 4; check_name := 'AU (FULL) raw literal DELETE on income_sources still succeeds (pre-existing 0108 coverage, preserved by the 0129 swap)';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  perform set_config('request.jwt.claims', '', true);

  -- 5. GB (GENERIC, confirmed) — THE CORE FIX — can now INSERT into all 3.
  perform set_config('request.jwt.claims', json_build_object('sub', v_gb, 'role', 'authenticated')::text, true);
  begin
    insert into public.income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
      values (v_gb, '_tmp_g5b_verify', 'salary', 100, 'monthly', 'AUD', true);
    insert into public.expense_items(user_id, expense_name, expense_category, amount, frequency, currency_code, is_active)
      values (v_gb, '_tmp_g5b_verify', 'other', 50, 'monthly', 'AUD', true);
    insert into public.insurance_policies(user_id, policy_name, cover_type, cover_amount, premium, premium_frequency, currency_code)
      values (v_gb, '_tmp_g5b_verify', 'life', 100000, 20, 'monthly', 'AUD');
    seq := 5; check_name := 'GB (GENERIC, confirmed) CAN now INSERT into income_sources/expense_items/insurance_policies — THE CORE FIX';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 5; check_name := 'GB (GENERIC, confirmed) CAN now INSERT into income_sources/expense_items/insurance_policies — THE CORE FIX';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 6. GB (GENERIC, confirmed) can UPDATE the row it just created.
  begin
    update public.income_sources set amount = 150 where user_id = v_gb and source_name = '_tmp_g5b_verify';
    seq := 6; check_name := 'GB (GENERIC, confirmed) CAN UPDATE its own income_sources row';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 6; check_name := 'GB (GENERIC, confirmed) CAN UPDATE its own income_sources row';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 7. GB (GENERIC, confirmed) can archive (soft-delete via UPDATE) its own row.
  begin
    update public.income_sources set is_active = false where user_id = v_gb and source_name = '_tmp_g5b_verify';
    seq := 7; check_name := 'GB (GENERIC, confirmed) CAN archive (UPDATE is_active=false) its own income_sources row';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 7; check_name := 'GB (GENERIC, confirmed) CAN archive (UPDATE is_active=false) its own income_sources row';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;

  -- 8. GB (GENERIC, confirmed) CANNOT issue a raw literal DELETE on
  -- income_sources — the manifest denies DELETE for all 3 tables.
  begin
    delete from public.income_sources where user_id = v_gb and source_name = '_tmp_g5b_verify';
    seq := 8; check_name := 'GB (GENERIC) raw literal DELETE on income_sources is REJECTED (manifest denies DELETE)';
    result := 'FAIL'; detail := 'THE DELETE SUCCEEDED — this is a real security gap'; return next;
  exception when others then
    seq := 8; check_name := 'GB (GENERIC) raw literal DELETE on income_sources is REJECTED (manifest denies DELETE)';
    if sqlerrm like '%COUNTRY_CONFIRMATION_REQUIRED%' then result := 'PASS'; else result := 'FAIL (wrong error)'; end if;
    detail := sqlerrm; return next;
  end;

  -- 9. GB (GENERIC, confirmed) is STILL blocked on assets (a table G5B does
  -- not certify) — the fix is scoped to exactly 3 tables, not a blanket relaxation.
  begin
    insert into public.assets(user_id, asset_name, asset_type, current_value, country_code, currency_code)
      values (v_gb, '_tmp_g5b_verify', 'other', 1000, 'AU', 'AUD');
    seq := 9; check_name := 'GB (GENERIC) is STILL blocked on assets (not a G5B-certified table)';
    result := 'FAIL'; detail := 'THE INSERT SUCCEEDED — this is a real security gap (G5B scope escaped)'; return next;
  exception when others then
    seq := 9; check_name := 'GB (GENERIC) is STILL blocked on assets (not a G5B-certified table)';
    if sqlerrm like '%COUNTRY_CONFIRMATION_REQUIRED%' then result := 'PASS'; else result := 'FAIL (wrong error)'; end if;
    detail := sqlerrm; return next;
  end;

  perform set_config('request.jwt.claims', '', true);

  -- 10. GB, UNCONFIRMED country: still blocked on income_sources, exactly as
  -- before — "must be confirmed" is not relaxed for GENERIC, only "must be
  -- AU/IN" is.
  perform set_config('request.jwt.claims', json_build_object('sub', v_gb_unconf, 'role', 'authenticated')::text, true);
  begin
    insert into public.income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
      values (v_gb_unconf, '_tmp_g5b_verify', 'salary', 100, 'monthly', 'AUD', true);
    seq := 10; check_name := 'GB, country UNCONFIRMED, is still blocked on income_sources (confirmation is not relaxed)';
    result := 'FAIL'; detail := 'THE INSERT SUCCEEDED — this is a real security gap'; return next;
  exception when others then
    seq := 10; check_name := 'GB, country UNCONFIRMED, is still blocked on income_sources (confirmation is not relaxed)';
    if sqlerrm like '%COUNTRY_CONFIRMATION_REQUIRED%' then result := 'PASS'; else result := 'FAIL (wrong error)'; end if;
    detail := sqlerrm; return next;
  end;
  perform set_config('request.jwt.claims', '', true);

  -- 11. income_sources/expense_items/insurance_policies carry NO onboarding
  -- exemption — this has been true since migration 0108 (Gap 1 fix), which
  -- narrowed the ONLY legitimate onboarding-time exemption to households
  -- INSERT/UPDATE. is_write_permitted() must NOT reintroduce a blanket
  -- exemption for these three tables — confirm an onboarding-incomplete
  -- GENERIC user is STILL rejected (this is the correct, unchanged
  -- behaviour, not a gap).
  -- v_gb_unconf is already onboarding_completed=true, country_confirmed_at=null
  -- from setup; flip onboarding_completed to false to reproduce migration
  -- 0108's exact Gap 1 scenario (onboarding-incomplete + country-unconfirmed
  -- client writing straight into a financial table) and confirm it is
  -- STILL rejected.
  update public.user_profiles set onboarding_completed = false where user_id = v_gb_unconf;
  perform set_config('request.jwt.claims', json_build_object('sub', v_gb_unconf, 'role', 'authenticated')::text, true);
  begin
    insert into public.income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
      values (v_gb_unconf, '_tmp_g5b_verify_onboarding', 'salary', 100, 'monthly', 'AUD', true);
    seq := 11; check_name := 'income_sources correctly has NO onboarding exemption (0108''s Gap 1 fix must not regress) — insert should be REJECTED';
    result := 'FAIL'; detail := 'THE INSERT SUCCEEDED — this would reintroduce migration 0108''s Gap 1 vulnerability'; return next;
  exception when others then
    seq := 11; check_name := 'income_sources correctly has NO onboarding exemption (0108''s Gap 1 fix must not regress) — insert should be REJECTED';
    if sqlerrm like '%COUNTRY_CONFIRMATION_REQUIRED%' then result := 'PASS'; else result := 'FAIL (wrong error)'; end if;
    detail := sqlerrm; return next;
  end;
  perform set_config('request.jwt.claims', '', true);
  update public.user_profiles set onboarding_completed = true where user_id = v_gb_unconf;

  -- 12. service_role bypass still works on the 3 certified tables (simulated
  -- via the service_role JWT claim, mirroring how PostgREST identifies a
  -- service-role request).
  perform set_config('request.jwt.claims', json_build_object('sub', v_gb_unconf, 'role', 'service_role')::text, true);
  begin
    insert into public.income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
      values (v_gb_unconf, '_tmp_g5b_verify_svc', 'salary', 100, 'monthly', 'AUD', true);
    seq := 12; check_name := 'service_role bypass still works on income_sources (0129''s new trigger)';
    result := 'PASS'; detail := ''; return next;
  exception when others then
    seq := 12; check_name := 'service_role bypass still works on income_sources (0129''s new trigger)';
    result := 'FAIL'; detail := sqlerrm; return next;
  end;
  perform set_config('request.jwt.claims', '', true);

  -- 13. Cleanup — delete the synthetic users and all rows they created;
  -- cascade must leave no residue.
  delete from auth.users where id in (v_au, v_gb, v_gb_unconf);
  delete from public.income_sources where user_id in (v_au, v_gb, v_gb_unconf);
  delete from public.expense_items where user_id in (v_au, v_gb, v_gb_unconf);
  delete from public.insurance_policies where user_id in (v_au, v_gb, v_gb_unconf);
  delete from public.assets where user_id in (v_au, v_gb, v_gb_unconf);

  select count(*) into v_n from (
    select 1 from public.user_profiles where user_id in (v_au, v_gb, v_gb_unconf)
    union all select 1 from public.income_sources where user_id in (v_au, v_gb, v_gb_unconf)
    union all select 1 from public.expense_items where user_id in (v_au, v_gb, v_gb_unconf)
    union all select 1 from public.insurance_policies where user_id in (v_au, v_gb, v_gb_unconf)
    union all select 1 from public.assets where user_id in (v_au, v_gb, v_gb_unconf)
  ) residue;
  seq := 13; check_name := 'cleanup left zero residue across every touched table';
  if v_n = 0 then result := 'PASS'; else result := 'FAIL'; end if;
  detail := 'rows remaining: ' || v_n; return next;

  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- B2. Run it and paste back the full result grid.
-- ---------------------------------------------------------------------------
select * from public._tmp_g5b_verify_0129() order by seq;

-- ---------------------------------------------------------------------------
-- B3. Remove the helper function — nothing of this script should remain in
-- the database once verification is complete.
-- ---------------------------------------------------------------------------
drop function public._tmp_g5b_verify_0129();
