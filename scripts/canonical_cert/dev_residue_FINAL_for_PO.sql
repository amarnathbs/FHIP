-- DEV ONLY (vqycarelcoijzwlpkpcz). Final live-DEV golden-pair re-verification pass on the merged
-- feature/canonical-upload-cert @ 285ac01 (0207-0214 + 0218 applied). Range A.
--
-- Section 1: forecast.tc048@example.test (d8039853-ae9f-4ed1-afd2-35138287d0b6) -- the CORRECT single-user
-- sequential golden-pair run (Household M then Household I, per neutralise.mjs's own documented design).
-- 12 rows the service role could not delete (GP-H1, same import-bridge-provenance guard the golden-pair
-- and security-review certifiers already hit): fhip_import_applications 2, liabilities 2,
-- fdh_liability_statements 2, fhip_import_proposals 2, fdh_financial_accounts 2, fdh_statement_uploads 2.
-- Every id below was created by this run (never a baseline fixture row).
--
-- Section 2: two ABANDONED range-A users, forecast.tc017@example.test (d9f5a...see id below) and
-- forecast.tc025@example.test -- an earlier attempt at this same pass that used TWO different fixture
-- users instead of the harness's documented single-user pattern. That produced a confounded (not
-- incorrect-product, just non-comparable) M-vs-I reading, so it was abandoned in favour of Section 1's
-- single-user run. Their created rows are still real DEV writes and need the same cleanup.
--
-- Also disclosed (NOT a DELETE -- cannot be undone): for tc048, Household I's approved bank/card/loan
-- statements back-filled the PRE-EXISTING August 2026 financial_snapshots row's monthly_income /
-- monthly_expenses / monthly_surplus / savings_rate / currency_code / fx_* columns from whatever the
-- original fixture value was to the golden-pair's own August actuals (financial_snapshots has no
-- updated_at column, so residue.mjs cannot see or restore this -- see the mission report). The row's
-- balance-sheet columns (net_worth, total_assets, total_liabilities) were never touched.
--
-- Run as ONE transaction in the DEV SQL editor; each DELETE must report the count in its comment, else ROLLBACK.
begin;
select set_config('fhip.import_bridge_internal_write', 'true', true);

-- ================= Section 1: forecast.tc048@example.test =================
delete from fhip_import_applications where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('763ac2b2-2331-4483-8798-e8ea6b711ac0', 'b5e99c7b-1f12-4bda-a9da-91fe79e5e777'); -- expect 2
delete from liabilities where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('52a6655a-5db0-4bab-bcbf-05b9cf387b82', '6a9b781d-eb2c-4ef9-af99-33614bc963a5'); -- expect 2
delete from fdh_liability_statements where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('dfa7d5ea-838b-47f0-9d1e-ac8aceb66c7d', 'aa3f8b75-4905-44ee-9eab-dbc952d9d800'); -- expect 2
delete from fhip_import_proposals where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('43a0df10-f790-444e-b2ba-9a32c7eac515', '4c3ad4b3-9ac3-42b5-ac94-880b6e8bbb5a'); -- expect 2
delete from fdh_financial_accounts where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('f59cd545-e0bd-4098-806c-9adc33bc95bf', 'db4ba386-92dc-486e-8e87-341b738f384e'); -- expect 2
delete from fdh_statement_uploads where user_id = 'd8039853-ae9f-4ed1-afd2-35138287d0b6' and id in ('3814c21b-f546-40b1-8df2-41d6fa2f9a5d', '1ec82350-9f49-4cee-81d3-92565d7b0ba0'); -- expect 2

-- ================= Section 2: forecast.tc025@example.test (abandoned tc017/tc025 attempt) =================
-- forecast.tc017@example.test (9bed77aa-e0dc-4b70-a7e6-8f6286e4fafb) is ALREADY CLEAN -- residue.mjs verify
-- shows its row set identical to baseline, so nothing to do for that user. The other half of that
-- abandoned attempt, forecast.tc025@example.test (60457111-1b20-4d17-aff5-ed5fdf3b8118), hit the exact
-- same GP-H1 liability-chain guard as tc048's Section 1 above (it was Household I's card+loan import in
-- that attempt): 12 rows, same 6 tables, 2 rows each.
delete from fhip_import_applications where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('8b468e69-6eaf-4ef7-bdbe-6af8de477de4', '86c482fd-2ba9-471e-bc51-e908d1c24649'); -- expect 2
delete from liabilities where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('d855e07c-ebff-442c-8fbd-2920c851d9dd', 'e1911af6-4d63-42d7-a472-22a61309d391'); -- expect 2
delete from fdh_liability_statements where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('0748bcc5-babc-4212-a6a3-29fae5349ed5', 'd98d419a-345b-4e48-b997-e9ed8d045995'); -- expect 2
delete from fhip_import_proposals where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('83909727-24df-407e-85b8-500d3822cb90', 'bf6c73b1-5971-4fa6-b5b3-2eb7ff13f135'); -- expect 2
delete from fdh_financial_accounts where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('8b773e7c-0cc4-47b7-84a1-674a736675f7', '115cd1c9-1d5c-41b5-8e1f-c0f4bab104d3'); -- expect 2
delete from fdh_statement_uploads where user_id = '60457111-1b20-4d17-aff5-ed5fdf3b8118' and id in ('818e4fcb-b3bc-4eac-b8e0-3ec37f8d2543', 'e9495d92-6c4c-4b02-9c49-cc72049fcd3a'); -- expect 2

commit;
