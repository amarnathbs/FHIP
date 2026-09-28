-- NAV 1 hydration incident (2026-09-29) -- PRODUCTION cleanup.
-- NOT YET APPLIED. Run only after 01_verify_before_delete.sql matches
-- exactly, and only by the PO or an operator with production SQL access via
-- the Supabase SQL editor for project twwpnltizhtjxhamyoxt.
--
-- Deletes ONLY the one dedicated "Synthetic Unresolvable Mutual Fund" test
-- folio (checkpoint 9 of the NAV1 P4 UI journey) by explicit row id --
-- never a broad WHERE on a shared column -- so this cannot touch any other
-- user's or any other account's data even if an id were somehow reused.
-- The other two accounts on the same test user (PPFAS, SBI -- real,
-- resolvable schemes) are untouched.
--
-- Order: children before parents, so this does not depend on any table's
-- particular ON DELETE behaviour.
--
-- Wrap in a transaction so a mistake anywhere rolls back everything: paste
-- the whole block, review the row counts each DELETE reports, and only then
-- decide COMMIT or ROLLBACK.

begin;

-- 1. FHIP publication (references the holding snapshot, account, instrument).
delete from ii_fhip_publications
where id = 'fb0fcbcc-43e7-42d3-ad90-679cf74a3558';

-- 2. Holding snapshot.
delete from ii_holding_snapshots
where id = '589853cb-aa4c-4681-9a20-f8ac331be907';

-- 3. Transaction.
delete from ii_transactions
where id = '27bddd07-190a-4ed0-adef-a8126aab48ab';

-- 4. Portfolio truth status (the row whose history_completeness =
--    'complete_from_inception' is what makes hydration treat the fake
--    scheme as permanently required -- this is the actual root cause row).
delete from ii_portfolio_truth_status
where id = 'b059901f-d61e-401c-a0f2-e419d1043150';

-- 5. This instrument's hydration-attempt ledger row (would also be removed
--    automatically by ON DELETE CASCADE once ii_instruments is deleted
--    below, per migration 0199 -- deleted explicitly first for clarity and
--    so its removal is visible in this script's own row count).
delete from ii_nav_hydration_attempts
where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 6. Instrument identifiers (isin + amfi_scheme_code).
delete from ii_instrument_identifiers
where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 7. The fake instrument itself.
delete from ii_instruments
where id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 8. The dedicated account/folio.
delete from ii_accounts
where id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 9. The source document (metadata only -- its S3 object was already purged
--    by the malware-scan cleanup job on upload).
delete from ii_source_documents
where id = '864b0cc0-a586-4349-8968-19aba69e0425';

-- Review the row counts reported above (each should be exactly 1, in order),
-- then either:
--   commit;
-- or, if anything looked wrong:
--   rollback;
