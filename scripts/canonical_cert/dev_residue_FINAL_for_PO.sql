-- DEV ONLY (vqycarelcoijzwlpkpcz). Final live-DEV verification dispatch
-- (feature/canonical-cert-final-concurrency-wp15, range B, user
-- 194dacdd-074e-4682-a602-909858653816 / forecast.tc012@example.test)
-- residue the service role cannot delete.
--
-- 18 rows: fhip_import_applications 3, fhip_import_proposals 3, liabilities 3,
-- fdh_liability_statements 3, fdh_financial_accounts 3, fdh_statement_uploads 3.
-- Each is a row created by the two liability-Apply concurrency journeys (card +
-- loan) in this dispatch -- never a baseline fixture row (residue.mjs verify
-- reported 0 missing, only extra). The 0218 security-hardening triggers
-- (trg_fdh_liability_statements_authoritative_insert_0218 and siblings) refuse
-- a direct authenticated-role write to these system-authoritative columns, so
-- the service role's own delete/null-out step is blocked -- same pattern as
-- the economic-oracles, golden-pair and security-review certifiers' own
-- dev_residue_*.sql files. Everything else this dispatch touched (WP-15
-- expense/asset proposals, retirement statements, the payslip/bank income
-- journey, the loan's own bank statement) was deleted automatically by
-- residue.mjs cleanup (538 rows) and is NOT in this file.
--
-- Run as ONE transaction in the DEV SQL editor. Expected: every DELETE reports
-- the count in its comment. If any count differs, ROLLBACK and re-check with
-- `node scripts/canonical_cert/residue.mjs verify --ledger FINALB-run1`.
begin;
select set_config('fhip.import_bridge_internal_write', 'true', true);
delete from fhip_import_applications where id in ('24a07f29-43b6-4f23-ba73-a89f0af06051', '9857b8a5-9d9e-4ef2-907f-9e3df4985b33', 'b8f279c4-b3f8-4db4-ac07-262a8a0aa1ac'); -- expect 3
delete from fhip_import_proposals where id in ('09aa19ff-7dd3-4122-8332-d6896a29252c', '6b44a49e-fde9-4ab9-b3fb-7073d754bfcd', 'f8b16005-8902-4e38-bd15-ebd03306723a'); -- expect 3
delete from liabilities where id in ('10ca8224-d01e-47cf-9fdc-b20ad4dd8c41', '85d95d31-40dc-4c50-bdd7-ad6ce9d77cb3', 'a60890cc-68de-42a6-9e5f-778b5b57ff4d'); -- expect 3
delete from fdh_liability_statements where id in ('3ccc4dd2-cff8-4172-87b2-d2f350849f58', '3f2e6884-654d-4e81-addd-103b4eb964c3', 'bd65223c-1330-4dd0-b922-dfed7846dfb5'); -- expect 3
delete from fdh_financial_accounts where id in ('122df0ed-3a2e-49f4-af28-c09d151935bc', 'c2c62397-0e2a-4460-9b49-5a825939b7f8', 'c3203bbb-58a7-4d8a-b0a7-f20323d1c914'); -- expect 3
delete from fdh_statement_uploads where id in ('32c0e926-a2dd-4989-875e-e43fba5ac4ba', '39d5f317-85e9-44ad-90d7-998cf570b07e', '685e1640-bdb5-4ea0-9211-dc6c15a9e0e4'); -- expect 3
commit;
