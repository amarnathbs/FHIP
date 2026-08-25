-- =============================================================================
-- Production verification script for 0082 / 0083 / 0086 / 0087 / 0088
-- (II-R11 Multi-source & Professional Expansion).
--
-- HOW TO USE:
--   Run PART A FIRST, BY ITSELF, BEFORE applying any of the 01-05 migration
--   files in this package -- it settles whether 0087/0088's specific
--   policies/trigger/constraints already exist under some other path (the
--   README explains why anon-key REST alone cannot answer this).
--   After applying 01-05 in order, run PART A again (expect every "already
--   applied" line to now read true/present) and then run PART B.
--
-- This script is split into two parts:
--   PART A -- pure read-only schema/catalogue checks. Safe, no side effects,
--             touches no rows. Uses pg_catalog/information_schema directly
--             (available to a human in the SQL Editor; NOT available to the
--             anon/publishable-key REST probe this agent used).
--   PART B -- live behavioural checks (the 0087 forgery guard, the 0088
--             cascade fix) that require an actual INSERT/UPDATE/constraint
--             exercise to prove the trigger/FK fires. Wrapped in a
--             transaction that ends in ROLLBACK, so nothing is persisted
--             regardless of outcome -- no real customer data is created,
--             touched, or left behind. Read the RAISE NOTICE lines in the
--             SQL Editor's "Messages"/output pane after running, since
--             ROLLBACK means no rows will appear in a SELECT afterwards
--             (that is the point).
--
-- This script was authored by an agent with NO ability to execute SQL
-- against production; it has been validated only against DEV (where 0087's
-- live reproduction is documented in R11_ACCEPTANCE_REPORT.md, LIVE-R11-P11,
-- and 0088's cascade fix is documented in that migration's own header). A
-- human must run this in production and confirm the results.
-- =============================================================================


-- =============================================================================
-- PART A -- read-only schema/catalogue presence checks (RUN THIS FIRST)
-- =============================================================================

-- A1. Tables from 0082/0086/0083 exist
select
  (to_regclass('public.ii_source_precedence_policy') is not null)      as ii_source_precedence_policy_exists,
  (to_regclass('public.professional_profiles') is not null)            as professional_profiles_exists,
  (to_regclass('public.professional_relationships') is not null)       as professional_relationships_exists,
  (to_regclass('public.professional_permission_scopes') is not null)   as professional_permission_scopes_exists,
  (to_regclass('public.professional_consent_audit') is not null)       as professional_consent_audit_exists,
  (to_regclass('public.professional_notes') is not null)               as professional_notes_exists,
  (to_regclass('public.professional_report_access_log') is not null)   as professional_report_access_log_exists;
-- BEFORE applying 01-05: EXPECT all false.
-- AFTER applying 01-05:  EXPECT all true.

-- A2. RLS enabled on all new tables (after applying)
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in (
    'ii_source_precedence_policy', 'professional_profiles', 'professional_relationships',
    'professional_permission_scopes', 'professional_consent_audit', 'professional_notes',
    'professional_report_access_log'
  )
  and relnamespace = 'public'::regnamespace;
-- AFTER applying: EXPECT relrowsecurity = true for all seven rows.

-- A3. CHECK constraints from 0082/0086 on pre-existing base tables
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname in ('ii_transactions_status_check', 'ii_reconciliation_cases_discrepancy_type_check');
-- BEFORE applying: definitions will NOT mention 'review_required' /
--   'cross_source_conflict' (or the constraints may be entirely absent /
--   named differently if never previously touched).
-- AFTER applying: 'review_required' must appear in the first definition,
--   'cross_source_conflict' must appear in the second.

-- A4. 0087: is the OLD single "for all" policy still present, or already
-- split into the new SELECT-only / narrower-UPDATE shape?
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('ii_transactions', 'ii_reconciliation_cases')
order by tablename, policyname;
-- BEFORE applying 0087: EXPECT to see a single broad policy per table
--   (e.g. named "own ii_transactions" / "own ii_reconciliation_cases") with
--   cmd = ALL. If instead you already see "read own ii_transactions" (cmd
--   SELECT) and "resolve own ii_reconciliation_cases" (cmd UPDATE) with NO
--   remaining ALL policy, 0087 has ALREADY been applied via some other path
--   -- STOP and do not re-run 04_0087_...sql; reconcile with the README's
--   ledger table instead of re-applying.
-- AFTER applying 0087: EXPECT exactly the split policies described above,
--   no remaining ALL-cmd policy on either table.

-- A5. 0087: trigger exists
select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname = 'trg_ii_reconciliation_cases_authoritative_write';
-- BEFORE applying: EXPECT 0 rows.
-- AFTER applying:  EXPECT 1 row, tgenabled = 'O' (enabled).

-- A6. 0088: FK cascade behaviour on professional_report_access_log
select
  conname,
  confdeltype  -- 'c' = CASCADE, 'a' = NO ACTION (the pre-0088 bug), 'n' = SET NULL
from pg_constraint
where conname in (
  'professional_report_access_log_professional_user_id_fkey',
  'professional_report_access_log_client_user_id_fkey'
);
-- Meaningful only after 0083 lands (table must exist first).
-- BEFORE 0088 (but after 0083): EXPECT confdeltype = 'a' (NO ACTION) for
--   both -- this is the exact bug 0088 fixes.
-- AFTER 0088: EXPECT confdeltype = 'c' (CASCADE) for both.

-- A7. 0083: functions/triggers exist
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'enforce_professional_relationship_transition',
    'enforce_professional_scope_irreversible_revocation',
    'audit_professional_relationship_change',
    'audit_professional_scope_change'
  )
order by proname;
-- AFTER applying 0083: EXPECT all 4 present.

select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname in (
    'trg_enforce_professional_relationship_transition',
    'trg_enforce_professional_scope_irreversible_revocation',
    'trg_audit_professional_relationship_insert',
    'trg_audit_professional_relationship_update',
    'trg_audit_professional_scope_insert',
    'trg_audit_professional_scope_update'
  )
order by tgname;
-- AFTER applying 0083: EXPECT all 6 present, tgenabled = 'O'.

-- A8. Sanity: R11 dedup invariant is unaffected by this package (informational)
select count(*) as ii_transactions_row_count from ii_transactions;
select count(*) as ii_reconciliation_cases_row_count from ii_reconciliation_cases;
-- Informational only -- these migrations are additive/policy-only, they do
-- not touch existing row data. Compare before/after: counts must be
-- IDENTICAL (if they differ, something outside this package's scope wrote
-- to these tables during the maintenance window -- investigate separately,
-- it is not a sign these migrations misbehaved, but is worth knowing).


-- =============================================================================
-- PART B -- live behavioural checks (self-cleaning: wrapped in a transaction
-- that always ends in ROLLBACK). Run this AFTER applying 01-05, as one
-- statement/paste, AFTER Part A confirms the schema objects are present.
-- =============================================================================

do $$
declare
  v_synthetic_user     uuid := gen_random_uuid();
  v_case_id            uuid;
  v_txn_id             uuid;
  v_err                text;
begin
  raise notice '--- SETUP: one synthetic user + one owned ii_reconciliation_cases row + one owned ii_transactions row, never committed (this whole DO block runs inside the outer transaction, which this script rolls back at the end) ---';

  insert into user_profiles (id, country_of_residence, display_name)
  values (v_synthetic_user, 'AU', '__r11_prod_verify_user__')
  on conflict (id) do nothing;

  -- Minimal owned rows to exercise the guard against. Column lists are
  -- deliberately conservative (only NOT NULL columns you can infer from the
  -- migrations above) -- if your actual ii_transactions/ii_reconciliation_cases
  -- schema requires additional NOT NULL columns not listed here (e.g.
  -- account_id, source_document_id), this INSERT will fail with a clear
  -- "null value in column ... violates not-null constraint" error naming
  -- the missing column -- add it and re-run Part B; this does not indicate
  -- 0087/0088 are broken, only that this generic script needs one more
  -- column filled in for your exact schema.
  begin
    insert into ii_reconciliation_cases (user_id, subject_type, subject_id, discrepancy_type, status, opened_at)
    values (v_synthetic_user, 'transaction', gen_random_uuid(), 'cross_source_conflict', 'open', now())
    returning id into v_case_id;
    raise notice 'SETUP: synthetic ii_reconciliation_cases row created (id %)', v_case_id;
  exception when others then
    raise notice 'SETUP FAILED creating ii_reconciliation_cases row -- adjust column list for your schema: %', sqlerrm;
  end;

  if v_case_id is not null then
    -- B1. 0087 GUARD: authenticated-role forgery of resolved_by_actor_type
    -- = 'system' must be rejected (this is the EXACT live forgery
    -- reproduced in LIVE-R11-P11). We simulate the authenticated role via
    -- SET LOCAL ROLE if your project grants it, otherwise this exercises
    -- the trigger directly regardless of role (the trigger itself checks
    -- auth.role() = 'authenticated', so run this as the `authenticated`
    -- Postgres role for a faithful reproduction; as the table owner/service
    -- role the trigger's guard clause will not fire, which would produce a
    -- false PASS -- if you cannot SET ROLE authenticated in your SQL Editor
    -- session, treat B1/B2 below as inconclusive and rely on a real
    -- REST-level test with a genuine user JWT instead, per the README).
    begin
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', v_synthetic_user::text, true);
    exception when others then
      raise notice 'NOTE: could not SET LOCAL ROLE authenticated in this session (%). B1/B2 below will run as the current role and are INCONCLUSIVE for proving the trigger -- see README for the REST-level alternative.', sqlerrm;
    end;

    begin
      update ii_reconciliation_cases
      set resolved_by_actor_type = 'system', status = 'resolved', resolved_at = now(), resolved_by = v_synthetic_user
      where id = v_case_id;
      raise notice 'B1 RESULT: UPDATE claiming resolved_by_actor_type=system succeeded -- if this ran as the authenticated role, this is a FAIL (0087 guard did not fire). If it ran as service-role/owner (see NOTE above), this is EXPECTED and NOT a failure.';
    exception when others then
      get stacked diagnostics v_err = message_text;
      raise notice 'B1 PASS (or N/A if not running as authenticated -- see NOTE above): forged system-actor resolution correctly rejected: %', v_err;
    end;

    -- B2. NEGATIVE CONTROL: the one legitimate transition (status -> resolved,
    -- resolved_by = caller's own id, actor_type left as 'user') must still
    -- succeed for the owning user -- 0087 must not be over-broad.
    begin
      update ii_reconciliation_cases
      set status = 'resolved', resolved_at = now(), resolved_by = v_synthetic_user, resolved_by_actor_type = 'user', resolution_method = 'user_mapped_instrument'
      where id = v_case_id;
      raise notice 'B2 PASS: legitimate self-resolution (actor_type=user) succeeded -- guard is narrow, as designed.';
    exception when others then
      raise notice 'B2 FAIL (guard is over-broad -- blocked the one legitimate user action): %', sqlerrm;
    end;
  else
    raise notice 'B1/B2 SKIPPED: no case id from SETUP to test against.';
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

-- If your SQL Editor auto-commits per statement rather than treating the
-- whole pasted script as one transaction, wrap the entire PART B block
-- explicitly in BEGIN; ... (the DO block) ... ROLLBACK; instead.

-- Confirm no synthetic rows survived:
select count(*) as leaked_synthetic_users
from user_profiles
where display_name = '__r11_prod_verify_user__';
-- EXPECT: 0. If this is not 0, manually delete the synthetic user_profiles
-- row (and any ii_reconciliation_cases/ii_transactions rows referencing it)
-- before closing this out -- do not leave synthetic data in production.

-- 0088 cascade fix cannot be exercised here without actually deleting an
-- auth.users row, which this script deliberately does not do (too
-- destructive for a verification script, even inside a transaction that
-- rolls back -- auth.users deletion can have side effects via Supabase Auth
-- hooks that a ROLLBACK does not undo). A9 in Part A (confdeltype = 'c')
-- is the intended proof for 0088; a live delete-a-real-throwaway-auth-user
-- test, if desired, should be run separately and deliberately by a human
-- using the Admin API, not via this generic script.
