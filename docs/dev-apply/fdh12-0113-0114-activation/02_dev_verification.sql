-- =============================================================================
-- DEV verification script for FDH-12 hotfix migrations 0113 and 0114.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- On 2026-08-30 the Product Owner reported that
--   0113_fdh12_approve_rpc_authoritative_write_fix.sql
--   0114_fdh12_retirement_provenance_guards.sql
-- had both been applied to DEV (vqycarelcoijzwlpkpcz) with no error.
--
-- The live re-certification run that followed proves that NEITHER migration is
-- in effect in that database. Reproduced repeatedly, as an ordinary
-- AUTHENTICATED end user over PostgREST (no service role, no SQL access):
--
--   0113 — POST /rest/v1/rpc/fdh12_approve_retirement_statement
--          by the statement's OWN owner, on a 'pending' row
--       -> 400 P0001 "fdh_retirement_statements: this field is
--                     system-authoritative and may not be written directly by
--                     the authenticated role"
--          approval_status stayed 'pending', approved_at/approved_by null.
--          That is verbatim the UNFIXED 0112 behaviour that 0113 exists to
--          remove.
--
--   0114 — PATCH /rest/v1/retirement_accounts?id=eq.<own row>
--            {"source_type": "retirement_statement_import"}   -> 200 SUCCEEDED
--            {"last_imported_at": "<chosen timestamp>"}       -> 200 SUCCEEDED
--            {"last_import_application_id": null, ...}        -> 200 SUCCEEDED
--          POSITIVE CONTROL, same user, same session, same request shape, same
--          column, on the FDH-9 table that DOES carry the equivalent 0091
--          guard:
--            PATCH income_sources {"last_imported_at": "<same timestamp>"}
--                                                             -> 400 P0001
--                 "income_sources: source_type/last_import_application_id/
--                  last_imported_at are import-bridge provenance and may not be
--                  written directly by the authenticated role"
--          So the request shape is valid and the guard pattern works in this
--          database — it is simply absent from retirement_accounts.
--
-- A "no error" result from the SQL editor is therefore not evidence the
-- migration landed. This script determines what is actually in the database.
--
-- HOW TO USE
-- ----------
-- Paste and run the whole file in the DEV Supabase project's SQL Editor and
-- paste the full result grid back. It is READ-ONLY: it creates nothing, drops
-- nothing and changes no row. It only reports.
--
-- Supabase Studio's SQL Editor does not show a Notices panel (established in
-- this repo by the FDH-2 DEV round), so every check returns a literal row in
-- the result grid rather than a RAISE NOTICE.
--
-- Authored by an agent with NO DDL-execution capability against any hosted
-- Supabase project — no CLI project link, no reachable SQL-execution RPC, no
-- connection string. Neither 0113 nor 0114 has been applied by that agent
-- anywhere, and production has not been touched.
-- =============================================================================


-- =============================================================================
-- PART A — is each object 0113/0114 declares actually present?
-- =============================================================================
select
  'A1. functions declared by 0113/0114' as check_name,
  p.proname                            as object_name,
  case when p.prosecdef then 'security definer' else 'security invoker' end as security,
  'PRESENT'                            as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'fdh12_retirement_statements_assert_authoritative_write',  -- 0113 replaces
    'fdh12_approve_retirement_statement',                      -- 0113 replaces
    'fdh12_assert_retirement_import_link_owner',               -- 0114 creates
    'fdh12_retirement_accounts_assert_provenance_write'        -- 0114 creates
  )
order by p.proname;
-- EXPECT after a successful apply: 4 rows.
-- If the two 0114 function names are MISSING, 0114 did not run at all.


select
  'A2. triggers declared by 0114 on retirement_accounts' as check_name,
  t.tgname                                              as trigger_name,
  p.proname                                             as calls_function,
  not t.tgisinternal                                    as is_user_trigger,
  t.tgenabled                                           as enabled_flag
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc  p on p.oid = t.tgfoid
where c.relname = 'retirement_accounts'
  and not t.tgisinternal
order by t.tgname;
-- EXPECT after a successful apply: rows including
--   trg_retirement_accounts_import_link_owner
--   trg_retirement_accounts_provenance_write
-- with tgenabled = 'O' (enabled, origin).
-- The live evidence above says these two are ABSENT. If they are absent here
-- too, 0114 is confirmed not applied. If they are PRESENT but tgenabled is
-- 'D', they exist but are DISABLED, which would produce exactly the same
-- observed behaviour.


-- =============================================================================
-- PART B — do the two REPLACED function bodies contain their 0113 fix?
--
-- 0113 does not add objects; it replaces two existing ones. Presence in PART A
-- therefore proves nothing about 0113. The fix is only in effect if the GUC
-- appears in BOTH bodies.
-- =============================================================================
select
  'B1. 0113 fix present in each replaced body' as check_name,
  p.proname                                   as function_name,
  position('import_bridge_internal_write' in pg_get_functiondef(p.oid)) > 0
                                              as mentions_import_bridge_guc,
  case
    when position('import_bridge_internal_write' in pg_get_functiondef(p.oid)) > 0
      then '0113 IS in effect for this function'
    else '0113 IS NOT in effect for this function — still the 0112 body'
  end                                         as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'fdh12_retirement_statements_assert_authoritative_write',
    'fdh12_approve_retirement_statement'
  )
order by p.proname;
-- EXPECT after a successful apply: 2 rows, both mentions_import_bridge_guc = true.
-- The guard function must honour the GUC AND the approve RPC must set it.
-- Either one missing reproduces the observed 400 P0001 exactly.


-- =============================================================================
-- PART C — the reference implementation, for comparison.
--
-- These are the FDH-9 (0091) and FDH-10 (0096) objects that 0114 transposes.
-- They are known to work in this database (proven live by the positive control
-- quoted in the header). Their presence next to 0114's absence in PART A2 is
-- the clearest possible signal that this is a missing apply, not a broken
-- pattern.
-- =============================================================================
select
  'C1. equivalent guards on the sibling canonical registers' as check_name,
  c.relname                                                  as table_name,
  t.tgname                                                   as trigger_name,
  t.tgenabled                                                as enabled_flag
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal
  and c.relname in ('income_sources', 'liabilities', 'retirement_accounts')
  and (t.tgname ilike '%provenance%' or t.tgname ilike '%import_link%')
order by c.relname, t.tgname;
-- EXPECT: income_sources and liabilities each carry their provenance and
-- import-link guards. retirement_accounts should carry the matching pair once
-- 0114 has genuinely been applied.


-- =============================================================================
-- PART D — one-line verdict per migration.
-- =============================================================================
select
  '0113 (approve RPC authoritative-write fix)' as migration,
  case when (
    select bool_and(position('import_bridge_internal_write' in pg_get_functiondef(p.oid)) > 0)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fdh12_retirement_statements_assert_authoritative_write',
                        'fdh12_approve_retirement_statement')
  ) then 'APPLIED AND IN EFFECT'
    else 'NOT IN EFFECT — re-apply required'
  end as verdict
union all
select
  '0114 (retirement_accounts provenance guards)',
  case when (
    select count(*) = 2
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and c.relname = 'retirement_accounts'
      and t.tgname in ('trg_retirement_accounts_import_link_owner',
                       'trg_retirement_accounts_provenance_write')
      and t.tgenabled = 'O'
  ) then 'APPLIED AND IN EFFECT'
    else 'NOT IN EFFECT — re-apply required'
  end;
-- Both rows must read 'APPLIED AND IN EFFECT' before the FDH-12 live suite can
-- be expected to reach a clean pass. Paste this grid back with the others.
