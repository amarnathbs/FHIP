-- DEV ONLY (vqycarelcoijzwlpkpcz). Security-review certifier (range D) residue the service role cannot delete.
-- 5 rows: fhip_import_applications 1, fhip_import_proposals 1, liabilities 1, fdh_liability_statements 1, fdh_financial_accounts 1, fdh_statement_uploads 0.
-- Each is a row created by the certification run (never a baseline fixture row: verify reported 0 missing).
-- Run as ONE transaction in the DEV SQL editor. Expected: every DELETE reports the count in its comment.
begin;
select set_config('fhip.import_bridge_internal_write', 'true', true);
delete from fhip_import_applications where id in ('4440b4de-e3e3-44f8-9351-655ff88b0f64'); -- expect 1
delete from fhip_import_proposals where id in ('9b0acf18-3908-4c70-857e-039717bf53a1'); -- expect 1
delete from liabilities where id in ('5348d845-2583-4b5d-8691-831ed7d1bf09'); -- expect 1
delete from fdh_liability_statements where id in ('b80c499f-d5b2-42b9-9f54-e4c95200cfba'); -- expect 1
delete from fdh_financial_accounts where id in ('961ce415-841a-4100-9cd1-ce093a4b86ae'); -- expect 1
commit;
