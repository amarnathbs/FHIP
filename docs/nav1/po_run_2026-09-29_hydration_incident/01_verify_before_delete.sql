-- NAV 1 hydration incident (2026-09-29) -- PRODUCTION, read-only verification.
-- Run this FIRST and read every row. Only proceed to 02_delete_test_folio.sql
-- if everything here matches exactly what this comment says it should.
--
-- Expected: every query below returns EXACTLY the rows named, and nothing
-- else. If any query returns more rows, extra instrument_ids, or a different
-- user_id than 196cadf7-3043-4b4f-9386-f7ec3a4a5767, STOP -- something has
-- changed since this was written (2026-09-28/29) and the delete list below
-- must be re-derived, not run as-is.

-- 1. The fake instrument itself -- expect exactly 1 row, AMFI code 999999,
--    ISIN INF999Z99ZZ9, amc_name 'Synthetic Unresolvable Mutual Fund'.
select id, instrument_name, isin, amc_name, status, created_at
from ii_instruments
where id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 2. Its identifiers -- expect exactly 2 rows (isin, amfi_scheme_code).
select id, identifier_scheme, identifier_value
from ii_instrument_identifiers
where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 3. Its dedicated account/folio -- expect exactly 1 row, folio
--    927010000009, institution_name 'Synthetic Unresolvable Mutual Fund'.
select id, user_id, owner_member_id, institution_name, folio_number, created_at
from ii_accounts
where id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 4. Confirm the account has ONLY this one instrument's transaction(s) --
--    expect exactly 1 row, source_reference 'NAV1P4-901'.
select id, instrument_id, source_reference, transaction_date, units, gross_amount
from ii_transactions
where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 5. Holding snapshot(s) -- expect exactly 1 row.
select id, instrument_id, as_of_date, units, value
from ii_holding_snapshots
where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 6. Portfolio truth status -- expect exactly 1 row, certified,
--    complete_from_inception (this is what makes hydration treat the fake
--    scheme as permanently required).
select id, status, history_completeness, certified_at
from ii_portfolio_truth_status
where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 7. FHIP publication -- expect exactly 1 row, published_value 5000.
select id, status, include_in_net_worth, published_value, target_master_item_key
from ii_fhip_publications
where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';

-- 8. The source document -- expect exactly 1 row,
--    original_filename 'nav1-p4-unresolved.pdf' (storage already purged by
--    the malware-scan cleanup job, so this is metadata-only; no S3 object to
--    delete separately).
select id, original_filename, status, storage_purged_at
from ii_source_documents
where id = '864b0cc0-a586-4349-8968-19aba69e0425';

-- 9. This instrument's hydration-attempt ledger row -- expect exactly 1 row,
--    consecutive_failures climbing (11-12+ as of this writing).
select instrument_id, last_outcome, consecutive_failures, attempts_total, last_attempted_at
from ii_nav_hydration_attempts
where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- 10. Confirm the OTHER two accounts on the same test user are real,
--     resolvable schemes and are NOT part of this delete (sanity check --
--     these must NOT appear in any of the queries above, and are not
--     touched by 02_delete_test_folio.sql).
select id, institution_name, folio_number
from ii_accounts
where user_id = '196cadf7-3043-4b4f-9386-f7ec3a4a5767'
  and id <> 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
