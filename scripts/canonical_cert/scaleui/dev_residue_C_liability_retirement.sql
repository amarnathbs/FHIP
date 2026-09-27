-- DEV ONLY (vqycarelcoijzwlpkpcz). Scale-and-UI certifier (range C) residue the service role cannot remove.
-- Fixture user: fhip.e2e.tc001@test.fhip.invalid (e9ff2441-05bf-441d-8d2c-a7c7549d6ec7). Nothing else is touched.
--
-- 8 rows CREATED by the certification run (verify: 0 baseline rows missing, 8 extra):
--   fhip_import_applications 2, fhip_import_proposals 2, fdh_liability_statements 1, fdh_financial_accounts 1,
--   liabilities 1, fdh_statement_uploads 1  -- the credit-card Apply chain + the retirement Apply record.
-- 1 PRE-EXISTING fixture row UPDATED by the retirement Apply: retirement_accounts 7d09f0be. Its value columns
--   were already restored through the service role (9600 / 524.40 / monthly, from application 458ddd7b's
--   previous_values); its 3 provenance columns are trigger-guarded (0114) and are restored here to the
--   fixture's own values (source_type 'manual', no import link -- as every sibling E2E50 fixture row).
--
-- Run as ONE transaction in the DEV SQL editor. Every step asserts its row count; any mismatch aborts all.
begin;
select set_config('fhip.import_bridge_internal_write', 'true', true);

do $$
declare
  u constant uuid := 'e9ff2441-05bf-441d-8d2c-a7c7549d6ec7';
  n int;
begin
  -- Guard: this must be DEV's fixture user, and every row below must belong to it.
  if (select count(*) from auth.users where id = u and email = 'fhip.e2e.tc001@test.fhip.invalid') <> 1 then
    raise exception 'not the DEV fixture user -- wrong database?';
  end if;

  -- 1. Restore the fixture retirement account's provenance (frees application 458ddd7b).
  update retirement_accounts
     set source_type = 'manual', last_import_application_id = null, last_imported_at = null,
         current_balance = 9600, employer_contribution = 524.40, contribution_frequency = 'monthly'
   where id = '7d09f0be-30a9-5efa-98da-3babf1d12405' and user_id = u;
  get diagnostics n = row_count; if n <> 1 then raise exception 'retirement_accounts restore: % rows', n; end if;

  -- 2. Unlink the certification's own card liability from its application (it is deleted in step 6).
  update liabilities set last_import_application_id = null
   where id = '05bf0114-77d0-464c-9a15-446b67038666' and user_id = u;
  get diagnostics n = row_count; if n <> 1 then raise exception 'liabilities unlink: % rows', n; end if;

  delete from fhip_import_applications where user_id = u and id in ('458ddd7b-1ab2-44e7-b900-feab48e768df', '28b728c7-32c3-4fc8-a88f-362deebc2d81');
  get diagnostics n = row_count; if n <> 2 then raise exception 'fhip_import_applications: % rows (expected 2)', n; end if;

  delete from fhip_import_proposals where user_id = u and id in ('3c0fc5cc-c320-4d6d-aa42-af2e8a5a9351', 'a81a5432-07f1-43d1-a034-16b3dbb5a566');
  get diagnostics n = row_count; if n <> 2 then raise exception 'fhip_import_proposals: % rows (expected 2)', n; end if;

  delete from fdh_liability_statements where user_id = u and id = '920731d8-a9e2-40c7-a13a-a035f74913a9';
  get diagnostics n = row_count; if n <> 1 then raise exception 'fdh_liability_statements: % rows (expected 1)', n; end if;

  delete from fdh_financial_accounts where user_id = u and id = 'd83543ee-fffb-4e52-b4cb-ae778b007ec7';
  get diagnostics n = row_count; if n <> 1 then raise exception 'fdh_financial_accounts: % rows (expected 1)', n; end if;

  delete from liabilities where user_id = u and id = '05bf0114-77d0-464c-9a15-446b67038666';
  get diagnostics n = row_count; if n <> 1 then raise exception 'liabilities: % rows (expected 1)', n; end if;

  delete from fdh_statement_uploads where user_id = u and id = 'e0d222cb-710e-40f7-b5d4-60aad132f2d1';
  get diagnostics n = row_count; if n <> 1 then raise exception 'fdh_statement_uploads: % rows (expected 1)', n; end if;

  raise notice 'range C residue removed: 8 rows deleted, 1 fixture row restored';
end $$;

commit;
-- Afterwards the certifier (or PO) runs: node scripts/canonical_cert/residue.mjs verify --ledger C-scaleui  -> ok: true
