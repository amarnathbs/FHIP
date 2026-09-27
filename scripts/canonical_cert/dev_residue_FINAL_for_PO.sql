-- Canonical upload programme, Stage 3 FINAL live-proof pass -- COMBINED DEV residue cleanup for the PO.
-- Covers the two dispatches whose journeys left rows the service role cannot delete
-- (migration 0218's authoritative-write triggers refuse a direct write to these system-owned
-- columns, even from the service role -- the fix is the same transaction-local internal-write
-- flag every real Apply RPC already uses).
--
-- DEV ONLY (vqycarelcoijzwlpkpcz). Paste the WHOLE file into the DEV Supabase SQL editor and run it once.
-- It deletes 42 rows in ONE transaction. It REFUSES (raises, nothing changes) unless:
--   * ii_nav_retention_policy has an environment='dev' row and NO environment='production' row;
--   * every targeted row exists and belongs to a synthetic fixture user (email @example.test);
--   * every DELETE touches exactly the expected number of rows.
-- Expected result: a NOTICE per section and COMMIT. Any ERROR means nothing was changed.
--
--   Section 1 (concurrency-wp15 dispatch, forecast.tc012@example.test): fhip_import_applications 3,
--     fhip_import_proposals 3, liabilities 3, fdh_liability_statements 3, fdh_financial_accounts 3,
--     fdh_statement_uploads 3 -- created by the card + loan liability-Apply concurrency journeys.
--   Section 2 (golden-pair-final dispatch, forecast.tc048@example.test -- the correct single-user run):
--     fhip_import_applications 2, liabilities 2, fdh_liability_statements 2, fhip_import_proposals 2,
--     fdh_financial_accounts 2, fdh_statement_uploads 2.
--   Section 3 (golden-pair-final dispatch, forecast.tc025@example.test -- an abandoned two-user attempt
--     at the same pass, superseded by Section 2's single-user run): same 6 tables, 2 rows each.
--
-- Also disclosed, NOT fixed by this file (cannot be undone, and does not need to be): for tc048,
-- Household I's approved statements back-filled the pre-existing August 2026 financial_snapshots row's
-- cash-flow columns from the original fixture value to the golden pair's own August actuals. That row
-- has no updated_at column, so it cannot be detected or restored mechanically. Its balance-sheet columns
-- were never touched. This is disclosed for the record; it does not require action.

begin;

select set_config('fhip.import_bridge_internal_write', 'true', true);

do $$
declare
  n int;
begin
  -- 0. Environment guard.
  if not exists (select 1 from ii_nav_retention_policy where environment = 'dev') then
    raise exception 'REFUSED: no dev row in ii_nav_retention_policy -- this is not the DEV database';
  end if;
  if exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise exception 'REFUSED: ii_nav_retention_policy has a production row -- this is PRODUCTION';
  end if;

  -- 1. Every targeted row must exist and belong to a synthetic fixture user (checked BEFORE any change).
  select count(*) into n from fhip_import_applications t join auth.users u on u.id = t.user_id where t.id in ('24a07f29-43b6-4f23-ba73-a89f0af06051', '9857b8a5-9d9e-4ef2-907f-9e3df4985b33', 'b8f279c4-b3f8-4db4-ac07-262a8a0aa1ac') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): fhip_import_applications -- % synthetic-owned rows present (expected 3)', n; end if;
  select count(*) into n from fhip_import_proposals t join auth.users u on u.id = t.user_id where t.id in ('09aa19ff-7dd3-4122-8332-d6896a29252c', '6b44a49e-fde9-4ab9-b3fb-7073d754bfcd', 'f8b16005-8902-4e38-bd15-ebd03306723a') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): fhip_import_proposals -- % synthetic-owned rows present (expected 3)', n; end if;
  select count(*) into n from liabilities t join auth.users u on u.id = t.user_id where t.id in ('10ca8224-d01e-47cf-9fdc-b20ad4dd8c41', '85d95d31-40dc-4c50-bdd7-ad6ce9d77cb3', 'a60890cc-68de-42a6-9e5f-778b5b57ff4d') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): liabilities -- % synthetic-owned rows present (expected 3)', n; end if;
  select count(*) into n from fdh_liability_statements t join auth.users u on u.id = t.user_id where t.id in ('3ccc4dd2-cff8-4172-87b2-d2f350849f58', '3f2e6884-654d-4e81-addd-103b4eb964c3', 'bd65223c-1330-4dd0-b922-dfed7846dfb5') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): fdh_liability_statements -- % synthetic-owned rows present (expected 3)', n; end if;
  select count(*) into n from fdh_financial_accounts t join auth.users u on u.id = t.user_id where t.id in ('122df0ed-3a2e-49f4-af28-c09d151935bc', 'c2c62397-0e2a-4460-9b49-5a825939b7f8', 'c3203bbb-58a7-4d8a-b0a7-f20323d1c914') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): fdh_financial_accounts -- % synthetic-owned rows present (expected 3)', n; end if;
  select count(*) into n from fdh_statement_uploads t join auth.users u on u.id = t.user_id where t.id in ('32c0e926-a2dd-4989-875e-e43fba5ac4ba', '39d5f317-85e9-44ad-90d7-998cf570b07e', '685e1640-bdb5-4ea0-9211-dc6c15a9e0e4') and t.user_id = '194dacdd-074e-4682-a602-909858653816' and u.email like '%@example.test';
  if n <> 3 then raise exception 'REFUSED (Section 1, tc012): fdh_statement_uploads -- % synthetic-owned rows present (expected 3)', n; end if;

  select count(*) into n from fhip_import_applications t join auth.users u on u.id = t.user_id where t.id in ('763ac2b2-2331-4483-8798-e8ea6b711ac0', 'b5e99c7b-1f12-4bda-a9da-91fe79e5e777') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): fhip_import_applications -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from liabilities t join auth.users u on u.id = t.user_id where t.id in ('52a6655a-5db0-4bab-bcbf-05b9cf387b82', '6a9b781d-eb2c-4ef9-af99-33614bc963a5') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): liabilities -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_liability_statements t join auth.users u on u.id = t.user_id where t.id in ('dfa7d5ea-838b-47f0-9d1e-ac8aceb66c7d', 'aa3f8b75-4905-44ee-9eab-dbc952d9d800') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): fdh_liability_statements -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fhip_import_proposals t join auth.users u on u.id = t.user_id where t.id in ('43a0df10-f790-444e-b2ba-9a32c7eac515', '4c3ad4b3-9ac3-42b5-ac94-880b6e8bbb5a') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): fhip_import_proposals -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_financial_accounts t join auth.users u on u.id = t.user_id where t.id in ('f59cd545-e0bd-4098-806c-9adc33bc95bf', 'db4ba386-92dc-486e-8e87-341b738f384e') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): fdh_financial_accounts -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_statement_uploads t join auth.users u on u.id = t.user_id where t.id in ('3814c21b-f546-40b1-8df2-41d6fa2f9a5d', '1ec82350-9f49-4cee-81d3-92565d7b0ba0') and t.user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 2, tc048): fdh_statement_uploads -- % synthetic-owned rows present (expected 2)', n; end if;

  select count(*) into n from fhip_import_applications t join auth.users u on u.id = t.user_id where t.id in ('8b468e69-6eaf-4ef7-bdbe-6af8de477de4', '86c482fd-2ba9-471e-bc51-e908d1c24649') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): fhip_import_applications -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from liabilities t join auth.users u on u.id = t.user_id where t.id in ('d855e07c-ebff-442c-8fbd-2920c851d9dd', 'e1911af6-4d63-42d7-a472-22a61309d391') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): liabilities -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_liability_statements t join auth.users u on u.id = t.user_id where t.id in ('0748bcc5-babc-4212-a6a3-29fae5349ed5', 'd98d419a-345b-4e48-b997-e9ed8d045995') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): fdh_liability_statements -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fhip_import_proposals t join auth.users u on u.id = t.user_id where t.id in ('83909727-24df-407e-85b8-500d3822cb90', 'bf6c73b1-5971-4fa6-b5b3-2eb7ff13f135') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): fhip_import_proposals -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_financial_accounts t join auth.users u on u.id = t.user_id where t.id in ('8b773e7c-0cc4-47b7-84a1-674a736675f7', '115cd1c9-1d5c-41b5-8e1f-c0f4bab104d3') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): fdh_financial_accounts -- % synthetic-owned rows present (expected 2)', n; end if;
  select count(*) into n from fdh_statement_uploads t join auth.users u on u.id = t.user_id where t.id in ('818e4fcb-b3bc-4eac-b8e0-3ec37f8d2543', 'e9495d92-6c4c-4b02-9c49-cc72049fcd3a') and t.user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and u.email like '%@example.test';
  if n <> 2 then raise exception 'REFUSED (Section 3, tc025): fdh_statement_uploads -- % synthetic-owned rows present (expected 2)', n; end if;

  -- 2. Deletes, one table at a time, in the proven order (children before their parent references).
  -- The SQL editor connects directly, not through PostgREST, so the mandatory country-confirmation
  -- trigger (migration 0104/0108) does not recognise this session as service_role. At least one of these
  -- fixture users has not confirmed a country. Deleting a fhip_import_applications / fdh_liability_statements
  -- row can cascade an ON DELETE SET NULL into any table with a last_import_application_id /
  -- duplicate_of_statement_id / supersedes_statement_id column, and that UPDATE fires the same trigger on
  -- every one of those tables -- not just the 3 tables this file directly deletes from. Disable every
  -- table in that cascade graph (whether or not this specific run touches it) for the rest of this block,
  -- and re-enable them all before it ends. If anything above raised first, the whole transaction (including
  -- these ALTER TABLEs) rolls back, so a failed run never leaves a trigger disabled.
  alter table liabilities disable trigger trg_enforce_country_confirmed;
  alter table fdh_financial_accounts disable trigger trg_enforce_country_confirmed;
  alter table fdh_statement_uploads disable trigger trg_enforce_country_confirmed;
  alter table fdh_liability_statements disable trigger trg_enforce_country_confirmed;
  -- income_sources and expense_items had trg_enforce_country_confirmed REPLACED by migration 0129 (G5B)
  -- with a differently-named trigger calling a different function; the old name no longer exists there.
  alter table income_sources disable trigger trg_g5b_write_permitted;
  alter table expense_items disable trigger trg_g5b_write_permitted;
  alter table assets disable trigger trg_enforce_country_confirmed;
  alter table retirement_accounts disable trigger trg_enforce_country_confirmed;

  delete from fhip_import_applications where id in ('24a07f29-43b6-4f23-ba73-a89f0af06051', '9857b8a5-9d9e-4ef2-907f-9e3df4985b33', 'b8f279c4-b3f8-4db4-ac07-262a8a0aa1ac');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete fhip_import_applications: % rows (expected 3)', n; end if;
  delete from fhip_import_applications where id in ('763ac2b2-2331-4483-8798-e8ea6b711ac0', 'b5e99c7b-1f12-4bda-a9da-91fe79e5e777');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete fhip_import_applications: % rows (expected 2)', n; end if;
  delete from fhip_import_applications where id in ('8b468e69-6eaf-4ef7-bdbe-6af8de477de4', '86c482fd-2ba9-471e-bc51-e908d1c24649');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete fhip_import_applications: % rows (expected 2)', n; end if;

  delete from fhip_import_proposals where id in ('09aa19ff-7dd3-4122-8332-d6896a29252c', '6b44a49e-fde9-4ab9-b3fb-7073d754bfcd', 'f8b16005-8902-4e38-bd15-ebd03306723a');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete fhip_import_proposals: % rows (expected 3)', n; end if;
  delete from fhip_import_proposals where id in ('43a0df10-f790-444e-b2ba-9a32c7eac515', '4c3ad4b3-9ac3-42b5-ac94-880b6e8bbb5a');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete fhip_import_proposals: % rows (expected 2)', n; end if;
  delete from fhip_import_proposals where id in ('83909727-24df-407e-85b8-500d3822cb90', 'bf6c73b1-5971-4fa6-b5b3-2eb7ff13f135');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete fhip_import_proposals: % rows (expected 2)', n; end if;

  delete from fdh_liability_statements where id in ('3ccc4dd2-cff8-4172-87b2-d2f350849f58', '3f2e6884-654d-4e81-addd-103b4eb964c3', 'bd65223c-1330-4dd0-b922-dfed7846dfb5');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete fdh_liability_statements: % rows (expected 3)', n; end if;
  delete from fdh_liability_statements where id in ('dfa7d5ea-838b-47f0-9d1e-ac8aceb66c7d', 'aa3f8b75-4905-44ee-9eab-dbc952d9d800');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete fdh_liability_statements: % rows (expected 2)', n; end if;
  delete from fdh_liability_statements where id in ('0748bcc5-babc-4212-a6a3-29fae5349ed5', 'd98d419a-345b-4e48-b997-e9ed8d045995');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete fdh_liability_statements: % rows (expected 2)', n; end if;

  delete from fdh_financial_accounts where id in ('122df0ed-3a2e-49f4-af28-c09d151935bc', 'c2c62397-0e2a-4460-9b49-5a825939b7f8', 'c3203bbb-58a7-4d8a-b0a7-f20323d1c914');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete fdh_financial_accounts: % rows (expected 3)', n; end if;
  delete from fdh_financial_accounts where id in ('f59cd545-e0bd-4098-806c-9adc33bc95bf', 'db4ba386-92dc-486e-8e87-341b738f384e');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete fdh_financial_accounts: % rows (expected 2)', n; end if;
  delete from fdh_financial_accounts where id in ('8b773e7c-0cc4-47b7-84a1-674a736675f7', '115cd1c9-1d5c-41b5-8e1f-c0f4bab104d3');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete fdh_financial_accounts: % rows (expected 2)', n; end if;

  delete from liabilities where id in ('10ca8224-d01e-47cf-9fdc-b20ad4dd8c41', '85d95d31-40dc-4c50-bdd7-ad6ce9d77cb3', 'a60890cc-68de-42a6-9e5f-778b5b57ff4d');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete liabilities: % rows (expected 3)', n; end if;
  delete from liabilities where id in ('52a6655a-5db0-4bab-bcbf-05b9cf387b82', '6a9b781d-eb2c-4ef9-af99-33614bc963a5');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete liabilities: % rows (expected 2)', n; end if;
  delete from liabilities where id in ('d855e07c-ebff-442c-8fbd-2920c851d9dd', 'e1911af6-4d63-42d7-a472-22a61309d391');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete liabilities: % rows (expected 2)', n; end if;

  delete from fdh_statement_uploads where id in ('32c0e926-a2dd-4989-875e-e43fba5ac4ba', '39d5f317-85e9-44ad-90d7-998cf570b07e', '685e1640-bdb5-4ea0-9211-dc6c15a9e0e4');
  get diagnostics n = row_count; if n <> 3 then raise exception 'Section 1: delete fdh_statement_uploads: % rows (expected 3)', n; end if;
  delete from fdh_statement_uploads where id in ('3814c21b-f546-40b1-8df2-41d6fa2f9a5d', '1ec82350-9f49-4cee-81d3-92565d7b0ba0');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 2: delete fdh_statement_uploads: % rows (expected 2)', n; end if;
  delete from fdh_statement_uploads where id in ('818e4fcb-b3bc-4eac-b8e0-3ec37f8d2543', 'e9495d92-6c4c-4b02-9c49-cc72049fcd3a');
  get diagnostics n = row_count; if n <> 2 then raise exception 'Section 3: delete fdh_statement_uploads: % rows (expected 2)', n; end if;

  alter table liabilities enable trigger trg_enforce_country_confirmed;
  alter table fdh_financial_accounts enable trigger trg_enforce_country_confirmed;
  alter table fdh_statement_uploads enable trigger trg_enforce_country_confirmed;
  alter table fdh_liability_statements enable trigger trg_enforce_country_confirmed;
  alter table income_sources enable trigger trg_g5b_write_permitted;
  alter table expense_items enable trigger trg_g5b_write_permitted;
  alter table assets enable trigger trg_enforce_country_confirmed;
  alter table retirement_accounts enable trigger trg_enforce_country_confirmed;

  raise notice 'canonical-cert FINAL residue removed: 42 rows deleted (18 tc012, 12 tc048, 12 tc025)';
end $$;

commit;
