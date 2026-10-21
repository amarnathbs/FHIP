-- WP-H pack 02 (READ ONLY, DEV first). The before and after check for a replacement copy.
-- Run it once BEFORE you upload a replacement copy and once AFTER the copy has been processed, then compare the two rows.
-- Replace the placeholder email with the account you are testing, then run the whole file.
-- For a copy of the SAME statement every number except parse_runs and audit_events must be identical.
-- For a corrected or extended copy only the numbers that the new content justifies may move.
-- Nothing is written.

with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
)
select
  (select count(*) from ii_accounts a where a.user_id = t.user_id) as accounts,
  (select count(*) from ii_transactions x where x.user_id = t.user_id) as transactions,
  (select coalesce(sum(x.gross_amount), 0) from ii_transactions x where x.user_id = t.user_id) as transaction_amount_sum,
  (select count(*) from ii_transaction_source_links l where l.user_id = t.user_id) as transaction_source_links,
  (select count(*) from ii_holding_snapshots s where s.user_id = t.user_id) as holding_snapshots,
  (select coalesce(sum(s.value), 0) from ii_holding_snapshots s where s.user_id = t.user_id) as holding_value_sum,
  (select count(distinct s.instrument_id) from ii_holding_snapshots s where s.user_id = t.user_id) as funds_held,
  (select count(*) from ii_fhip_publications p where p.user_id = t.user_id and p.status = 'published') as publications_published,
  (select count(*) from investments i where i.user_id = t.user_id and i.is_active) as investments_active,
  (select coalesce(sum(i.current_value), 0) from investments i where i.user_id = t.user_id and i.is_active) as investments_active_value,
  (select count(*) from ii_reconciliation_cases c where c.user_id = t.user_id and c.status = 'open' and c.severity = 'blocking') as open_blocking_cases,
  (select count(*) from ii_source_documents d where d.user_id = t.user_id) as statements,
  (select count(*) from ii_document_parse_runs r where r.user_id = t.user_id) as parse_runs,
  (select count(*) from ii_audit_events e where e.user_id = t.user_id) as audit_events
from target t;
