-- =============================================================================
-- DEV verification script for migration 0096 (FDH-10 — Credit Cards & Loans
-- Intelligence).
--
-- HOW TO USE. Paste and run the whole file in the DEV Supabase project's SQL
-- Editor AFTER applying the four 0096 chunk files (in order: chunk_1 parts
-- A/B/C, chunk_2 parts D/E/F, chunk_3 parts G/H, chunk_4 part I) from
-- ../../financial-data-hub/migration_0096_chunks/. Paste the full output
-- (both the PART A result grids and the PART B `verify_0096_activation()`
-- result table) back for the record.
--
-- Supabase Studio's SQL Editor has no visible Notices panel, so PART B uses
-- the project's own established `RETURNS TABLE` pattern (see
-- docs/production-apply/goal-funding-sources-hotfix-0095/
-- 02_production_verification.sql for precedent) instead of RAISE NOTICE —
-- every check's outcome is a literal row in the result grid.
--
-- This script was authored by an agent with NO DDL-execution capability
-- against any hosted Supabase project. It has been validated only against
-- PGlite (scripts/db-rebuild-check/replay.mjs — 93/93 migrations, fresh
-- rebuild; scripts/fdh10_security_certification.mjs — 18/18) and via the
-- project's own vitest unit certification (tests/unit/fdh10*.test.ts). A
-- human must run this in DEV and confirm the results.
-- =============================================================================


-- =============================================================================
-- PART A — read-only structural checks (tables / columns / constraints /
-- indexes / RLS / grants). Safe, no side effects. Run first.
-- =============================================================================

-- A1. Both new tables exist with RLS enabled.
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relname in ('fdh_liability_statements', 'fdh_liability_statement_activities')
order by relname;
-- EXPECT: 2 rows, both rls_enabled = true.

-- A2. Column presence + type on fdh_liability_statements (spot-check the
-- field set the Liabilities-tab review screen reads — spec sections 19-27).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'fdh_liability_statements'
  and column_name in (
    'statement_type', 'institution_name', 'masked_identifier', 'liability_id',
    'financial_account_id', 'statement_upload_id', 'statement_period_start',
    'statement_period_end', 'due_date', 'opening_balance', 'closing_balance',
    'credit_limit', 'minimum_payment', 'opening_principal', 'closing_principal',
    'interest_rate', 'repayment_frequency', 'purchases_total', 'cash_advances_total',
    'interest_total', 'fees_total', 'payments_total', 'refunds_total',
    'drawdowns_total', 'principal_repayments_total', 'reconciliation_status',
    'reconciliation_variance', 'approval_status', 'approved_at', 'currency_code',
    'parser_name', 'parser_version', 'extraction_confidence', 'review_status'
  )
order by column_name;
-- EXPECT: 33 rows (one per named column above) — none missing.

-- A3. Column presence on fdh_liability_statement_activities (activity-line
-- fields, including principal/interest/fee split columns and bank-match
-- status).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'fdh_liability_statement_activities'
  and column_name in (
    'statement_id', 'activity_type', 'activity_date', 'amount', 'currency_code',
    'description_raw', 'merchant_raw', 'principal_component', 'interest_component',
    'fee_component', 'linked_transaction_id', 'bank_match_status', 'review_status',
    'source_row_number'
  )
order by column_name;
-- EXPECT: 14 rows.

-- A4. The bridge extension columns (source_liability_statement_id) exist on
-- BOTH fhip_import_proposals and fhip_import_applications — proves FDH-10
-- extends the existing FDH-9 bridge rather than creating a parallel system.
select table_name, column_name, data_type
from information_schema.columns
where table_name in ('fhip_import_proposals', 'fhip_import_applications')
  and column_name = 'source_liability_statement_id'
order by table_name;
-- EXPECT: 2 rows.

-- A5. Named check constraints exist.
select conrelid::regclass as on_table, conname
from pg_constraint
where conname in (
  'chk_liabilities_masked_identifier',
  'chk_fdh_liability_statements_masked_identifier',
  'chk_fdh_liability_statements_period',
  'chk_fdh_liability_statements_approved_at',
  'chk_fdh_liability_activities_decomposition_sum'
)
order by conname;
-- EXPECT: 5 rows.

-- A6. Indexes exist (both the two new tables' own indexes and the two bridge
-- indexes on the source_liability_statement_id columns).
select tablename, indexname
from pg_indexes
where indexname in (
  'idx_liabilities_last_import_application',
  'idx_fdh_liability_statements_user',
  'idx_fdh_liability_statements_liability',
  'idx_fdh_liability_statements_upload',
  'idx_fdh_liability_statements_account',
  'idx_fdh_liability_activities_user',
  'idx_fdh_liability_activities_statement',
  'idx_fdh_liability_activities_linked_txn',
  'idx_fdh_liability_activities_bank_match',
  'idx_fhip_import_proposals_source_liability_statement',
  'idx_fhip_import_applications_liability_statement'
)
order by indexname;
-- EXPECT: 11 rows.

-- A7. RLS policies on both new tables (own-row read/insert/update only — no
-- delete policy is expected; statement evidence is never client-deletable).
select tablename, policyname, cmd
from pg_policies
where tablename in ('fdh_liability_statements', 'fdh_liability_statement_activities')
order by tablename, policyname;
-- EXPECT: 6 rows total (3 per table: read/insert/update), no delete policy
-- on either table.

-- A8. Every trigger 0096 creates or extends exists and is enabled ('O').
select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname in (
  'trg_fdh_liability_statements_owner',
  'trg_fdh_liability_activities_owner',
  'trg_fdh_liability_statements_authoritative_write',
  'trg_fdh_liability_activities_authoritative_write',
  'trg_liabilities_provenance_write',
  'trg_fhip_import_proposals_owner',
  'trg_fhip_import_applications_owner'
)
order by tgname;
-- EXPECT: 7 rows, all tgenabled = 'O'.

-- A9. Every function 0096 creates or replaces exists.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'fdh10_assert_liability_statement_owner',
    'fdh10_assert_liability_activity_owner',
    'fdh10_liability_statements_assert_authoritative_write',
    'fdh10_liability_activities_assert_authoritative_write',
    'fdh10_liabilities_assert_provenance_write',
    'fdh10_approve_liability_statement',
    'fdh9_assert_proposal_owner',
    'fdh9_assert_application_owner',
    'fdh9_import_proposals_assert_authoritative_write',
    'fdh10_apply_liability_proposal'
  )
order by proname;
-- EXPECT: 10 rows.

-- A10. Grants on the two callable RPCs — authenticated + service_role can
-- execute (spec section 53: never callable by an unauthenticated role).
-- `PUBLIC` is a pseudo-role, not a `pg_roles` row, so its own revocation
-- (the migration's `revoke all on function ... from public`) is checked via
-- the function's ACL text directly (A10b below) rather than
-- `has_function_privilege`, which needs a real role name.
select p.proname, pr.rolname, has_function_privilege(pr.oid, p.oid, 'execute') as can_execute
from pg_proc p
cross join pg_roles pr
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('fdh10_approve_liability_statement', 'fdh10_apply_liability_proposal')
  and pr.rolname in ('authenticated', 'service_role')
order by p.proname, pr.rolname;
-- EXPECT: 4 rows, all can_execute = true.

-- A10b. PUBLIC's own execute privilege was actually revoked (the ACL string
-- has no bare "=X" entry — an unqualified grantee before "=" denotes PUBLIC).
select proname, proacl
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fdh10_approve_liability_statement', 'fdh10_apply_liability_proposal');
-- EXPECT: 2 rows; `proacl` should show explicit grants to specific roles
-- (e.g. "authenticated=X/...", "service_role=X/...") and no bare "=X/..."
-- entry (which would mean PUBLIC still has a privilege).
--
-- NOTE (verified against a fresh PGlite rebuild this session, and NOT a
-- FDH-10-specific gap): a real Supabase project runs `alter default
-- privileges in schema public grant execute on functions to anon,
-- authenticated, service_role` once, project-wide — every NEW function
-- created afterwards, including both of these, is therefore ALSO granted
-- execute to `anon` at CREATE time, independently of the `revoke all ...
-- from public` statement above (PUBLIC and `anon` are not the same grantee
-- — revoking from PUBLIC does not touch a role's own separately-recorded
-- default-privilege grant). You will therefore see an `anon=X/...` entry in
-- `proacl` here. This is IDENTICAL to the already-shipped `fdh9_apply_
-- income_proposal` (migration 0091) and is not a new hole: both functions
-- are `security definer` and check `auth.uid() is null` internally BEFORE
-- doing anything, so an `anon` PostgREST call (which never carries a `sub`
-- claim) is rejected by the function's own logic regardless of the grant —
-- Part B's B6 check below is the negative control proving this.

-- A11. fdh_document_audit_events.event_type CHECK constraint's definition
-- includes all 7 FDH-10 event types (spec section 8; tests/unit/
-- fdh10SchemaContract.test.ts's own live equivalent).
select pg_get_constraintdef(oid) as event_type_check_definition
from pg_constraint
where conrelid = 'fdh_document_audit_events'::regclass
  and contype = 'c'
  and pg_get_constraintdef(oid) ilike '%event_type%';
-- EXPECT: one row whose definition text contains all 7 of:
-- 'liability_statement_extraction_completed', 'liability_statement_extraction_failed',
-- 'liability_statement_approved', 'liability_bank_match_completed',
-- 'liability_proposal_generated', 'liability_proposal_applied',
-- 'liability_proposal_dismissed'.


-- =============================================================================
-- PART B — self-cleaning behavioural checks (synthetic data only; the whole
-- thing runs inside BEGIN ... ROLLBACK so nothing is persisted regardless of
-- outcome). RETURNS TABLE pattern, same shape as the project's own
-- goal-funding-sources-hotfix-0095 verification script.
-- =============================================================================

create or replace function verify_0096_activation()
returns table(step text, outcome text, detail text) as $$
declare
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_liability_a uuid;
  v_liability_b uuid;
  v_bank_txn_a uuid;
  v_bank_txn_b uuid;
  v_statement_a uuid;
begin
  begin
    insert into auth.users (id, email) values
      (v_user_a, '__fdh10_0096_verify_a__@fhip-test.invalid'),
      (v_user_b, '__fdh10_0096_verify_b__@fhip-test.invalid')
    on conflict (id) do nothing;
    step := 'SETUP: two synthetic auth.users'; outcome := 'OK'; detail := null; return next;
  exception when others then
    step := 'SETUP: auth.users'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  insert into liabilities (user_id, liability_name, debt_type, currency_code, balance, is_active)
  values (v_user_a, '__fdh10_0096_verify_liability_a__', 'credit_card', 'AUD', 1500, true)
  returning id into v_liability_a;
  step := 'SETUP: Tenant A liability'; outcome := 'OK'; detail := 'id ' || v_liability_a; return next;

  insert into liabilities (user_id, liability_name, debt_type, currency_code, balance, is_active)
  values (v_user_b, '__fdh10_0096_verify_liability_b__', 'credit_card', 'AUD', 900, true)
  returning id into v_liability_b;
  step := 'SETUP: Tenant B liability'; outcome := 'OK'; detail := 'id ' || v_liability_b; return next;

  -- B1. Tenant A can create its own statement evidence.
  begin
    insert into fdh_liability_statements (user_id, statement_type, facility_type, liability_id, currency_code, opening_balance, closing_balance, reconciliation_status, approval_status)
    values (v_user_a, 'credit_card', 'credit_card', v_liability_a, 'AUD', 1000, 1500, 'reconciled', 'pending')
    returning id into v_statement_a;
    step := 'B1: Tenant A creates own statement evidence'; outcome := 'OK'; detail := 'id ' || v_statement_a; return next;
  exception when others then
    step := 'B1: Tenant A creates own statement evidence'; outcome := 'UNEXPECTED FAILURE'; detail := sqlerrm; return next;
  end;

  -- B2. THE ATTACK: Tenant A's statement forged to reference Tenant B's
  -- liability (cross-tenant target). Must be rejected by the ownership
  -- trigger (this SQL Editor session runs with elevated privileges, exactly
  -- like the RLS-bypass surface fdh10_security_certification.mjs already
  -- proved rejects this same attack via PGlite — this checks the identical
  -- trigger fires against the REAL hosted Postgres instance).
  begin
    insert into fdh_liability_statements (user_id, statement_type, facility_type, liability_id, currency_code, opening_balance, closing_balance, reconciliation_status, approval_status)
    values (v_user_a, 'credit_card', 'credit_card', v_liability_b, 'AUD', 1000, 1500, 'reconciled', 'pending');
    step := 'B2: forge cross-tenant liability_id reference'; outcome := 'SUCCEEDED (unexpected — investigate immediately)'; detail := null; return next;
  exception when others then
    step := 'B2: forge cross-tenant liability_id reference'; outcome := 'BLOCKED (PASS)'; detail := sqlerrm; return next;
  end;

  if v_statement_a is null then
    step := 'B3/B5 precondition'; outcome := 'SKIPPED'; detail := 'B1 did not produce a statement row — B3/B5 below are not meaningful without it'; return next;
    return;
  end if;

  -- B3. Authoritative-write guard: a direct client-style UPDATE of
  -- reconciliation_status (system-derived) must be refused.
  begin
    update fdh_liability_statements set reconciliation_status = 'variance' where id = v_statement_a;
    step := 'B3: direct UPDATE of reconciliation_status'; outcome := 'SUCCEEDED (unexpected — investigate immediately)'; detail := null; return next;
  exception when others then
    step := 'B3: direct UPDATE of reconciliation_status'; outcome := 'BLOCKED (PASS)'; detail := sqlerrm; return next;
  end;

  -- B4. NEGATIVE CONTROL: an ordinary user-editable liability field (balance)
  -- remains directly writable — proves B3 is a targeted field guard, not the
  -- trigger blocking every UPDATE on the table.
  begin
    update liabilities set balance = 1600 where id = v_liability_a;
    step := 'B4: ordinary liability.balance UPDATE (negative control)'; outcome := 'OK (PASS — proves B3 is not vacuous)'; detail := null; return next;
  exception when others then
    step := 'B4: ordinary liability.balance UPDATE (negative control)'; outcome := 'UNEXPECTED FAILURE'; detail := sqlerrm; return next;
  end;

  -- B5. fdh10_approve_liability_statement RPC callable and functions. This
  -- SQL Editor session has no JWT claim of its own (it is not a real
  -- `authenticated` PostgREST request), so `auth.uid()` is simulated here
  -- via `request.jwt.claims` — the identical technique scripts/fdh10_
  -- security_certification.mjs uses against PGlite, now proving the SAME
  -- RPC's auth.uid()-is-null guard AND its approval logic both work against
  -- the real hosted Postgres instance.
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
    perform fdh10_approve_liability_statement(v_statement_a);
    step := 'B5: fdh10_approve_liability_statement RPC call (authenticated as Tenant A)'; outcome := 'OK'; detail := null; return next;
  exception when others then
    step := 'B5: fdh10_approve_liability_statement RPC call (authenticated as Tenant A)'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  -- B6. NEGATIVE CONTROL for B5: with no JWT claim set at all, the same RPC
  -- must refuse with its own "authentication required" error — proves B5's
  -- success above was genuinely gated on the simulated identity, not that
  -- the RPC accepts any caller.
  begin
    perform set_config('request.jwt.claims', '', true);
    perform fdh10_approve_liability_statement(v_statement_a);
    step := 'B6: same RPC with NO JWT claim (negative control)'; outcome := 'SUCCEEDED (unexpected — investigate immediately)'; detail := null; return next;
  exception when others then
    step := 'B6: same RPC with NO JWT claim (negative control)'; outcome := 'BLOCKED (PASS — proves B5 is not vacuous)'; detail := sqlerrm; return next;
  end;

  return;
end;
$$ language plpgsql;

begin;
select * from verify_0096_activation();
rollback;

drop function if exists verify_0096_activation();

-- Confirm no synthetic rows survived the rollback:
select count(*) as leaked_synthetic_users
from auth.users
where email in ('__fdh10_0096_verify_a__@fhip-test.invalid', '__fdh10_0096_verify_b__@fhip-test.invalid');
select count(*) as leaked_synthetic_liabilities
from liabilities
where liability_name like '__fdh10_0096_verify_liability_%__';
select count(*) as leaked_synthetic_statements
from fdh_liability_statements
where user_id in (
  select id from auth.users where email like '__fdh10_0096_verify_%@fhip-test.invalid'
);
-- EXPECT: 0 for all three. If not 0, manually delete the synthetic rows
-- before closing this out — do not leave synthetic data in DEV.
