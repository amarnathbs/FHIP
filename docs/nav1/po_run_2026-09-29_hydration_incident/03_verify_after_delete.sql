-- NAV 1 hydration incident (2026-09-29) -- PRODUCTION, post-cleanup verify.
-- Run after 02_delete_test_folio.sql has been COMMITted. Every query below
-- should return zero rows.

select id from ii_instruments where id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';
select id from ii_instrument_identifiers where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';
select id from ii_accounts where id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
select id from ii_transactions where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
select id from ii_holding_snapshots where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
select id from ii_portfolio_truth_status where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
select id from ii_fhip_publications where account_id = 'dc5ee103-68e7-4e14-92ea-0e41e07ad013';
select id from ii_source_documents where id = '864b0cc0-a586-4349-8968-19aba69e0425';
select instrument_id from ii_nav_hydration_attempts where instrument_id = '5d826f98-d459-4c5a-82a6-74b2649ff2fa';

-- Sanity: the other two (real) accounts on the same test user should still
-- be present and untouched.
select id, institution_name, folio_number
from ii_accounts
where user_id = '196cadf7-3043-4b4f-9386-f7ec3a4a5767';

-- Next pc6_selective_historical_hydration tick (every 30 min) should now see
-- 19 instruments needing hydration, not 20, all already covered, and the
-- batch should classify as 'succeeded' with no error_code.
