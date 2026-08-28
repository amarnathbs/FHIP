-- Production precheck for migration 0092 (II-R12 Wider India Assets).
-- READ-ONLY. Run BEFORE applying 0092. Safe to run any number of times --
-- no writes, no synthetic data, no side effects.
--
-- Purpose: confirm production is in the expected PRE-0092 state before
-- pasting the migration, and confirm 0094 (already-applied, separately
-- shipped security fix that 0092's own header documents as a no-op for
-- this environment) is intact and has not drifted.
--
-- Run each numbered block and record the actual output next to the EXPECT
-- comment. Do not proceed to apply 0092 if any block's actual result
-- disagrees with its EXPECT line -- stop and investigate first.
-- =============================================================================

-- 1. Confirm 0092 has NOT already been applied (price_source column absent).
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'ii_holding_snapshots' and column_name = 'price_source';
-- EXPECT: 0 rows (column does not exist yet).
-- If this returns 1 row, 0092 (or an equivalent) is ALREADY applied --
-- STOP, do not re-apply blindly; reconcile with the orchestrating session
-- first (re-applying is designed to be idempotent/safe per the migration's
-- own guards, but confirm before proceeding rather than assuming).

-- 2. Confirm the CURRENT (pre-0092) transaction_type constraint does not
--    yet accept 'sale'.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'ii_transactions'::regclass
  and conname = 'ii_transactions_transaction_type_check';
-- EXPECT: a CHECK constraint whose value list does NOT include 'sale'.

-- 3. Confirm the CURRENT (pre-0092) basis constraint does not yet accept
--    'direct_listed_security_rule'.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'ii_scheme_tax_classification'::regclass
  and conname = 'ii_scheme_tax_classification_basis_check';
-- EXPECT: a CHECK constraint whose value list does NOT include
-- 'direct_listed_security_rule'.

-- 4. Confirm 0094 (ii_holding_snapshots authoritative-forgery hotfix) is
--    PRESENT and in its expected final shape -- SELECT-only for the owner,
--    no INSERT/UPDATE/DELETE policy for the authenticated role.
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where tablename = 'ii_holding_snapshots'
order by policyname;
-- EXPECT: exactly one row -- policyname = "read own ii_holding_snapshots",
-- cmd = SELECT. No ALL/UPDATE/INSERT/DELETE policy for authenticated.
-- If this does NOT match, STOP -- 0094 has drifted since its own
-- production application and 0092 must not be applied until that is
-- understood (0092 is designed to be a no-op against this policy, per its
-- own header, but that assumption depends on 0094 being exactly as
-- verified at 0094's own production apply time).

select relrowsecurity, relforcerowsecurity
from pg_class
where relname = 'ii_holding_snapshots' and relnamespace = 'public'::regnamespace;
-- EXPECT: relrowsecurity = true.

-- 5. Confirm the existing II positions read path is healthy before
--    touching anything (baseline health check -- run this as an
--    application-level check too, not just SQL: GET
--    /api/investment-intelligence/positions with a real session should
--    return HTTP 200 today). At the SQL level, confirm the table is
--    reachable and has the row shape the endpoint expects:
select count(*) as total_holding_snapshots,
       count(*) filter (where price_source is not null) as rows_with_price_source
from ii_holding_snapshots;
-- EXPECT: rows_with_price_source = 0 (price_source column does not exist
-- pre-0092 -- this query will actually FAIL with 42703 pre-0092, which is
-- itself confirmatory; re-run without the filter clause if you want a
-- plain row count pre-0092:
--   select count(*) from ii_holding_snapshots;

-- 6. Baseline counts to compare against post-apply (0092 must not change
--    any of these -- it is additive-only: one new enum value on each of
--    two constraints, plus one new nullable column).
select
  (select count(*) from ii_transactions) as ii_transactions_count,
  (select count(*) from ii_holding_snapshots) as ii_holding_snapshots_count,
  (select count(*) from ii_scheme_tax_classification) as ii_scheme_tax_classification_count,
  (select count(*) from ii_instruments) as ii_instruments_count;
-- EXPECT: record these four numbers now. Re-run the same query
-- immediately after applying 0092 -- all four must be byte-identical.

-- 7. Distinct observed values in the two columns 0092 widens (sanity check
--    that no existing row already uses a value 0092 will newly permit --
--    it shouldn't, since the constraint currently forbids them, but this
--    is belt-and-braces).
select distinct transaction_type from ii_transactions order by 1;
-- EXPECT: no 'sale' value present yet.

select distinct basis from ii_scheme_tax_classification order by 1;
-- EXPECT: no 'direct_listed_security_rule' value present yet.
