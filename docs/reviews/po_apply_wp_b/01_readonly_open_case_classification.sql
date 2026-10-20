-- WP-B pack 01 (READ ONLY, DEV first). Classifies every OPEN reconciliation case by what its resolution really needs.
-- Nothing is written. Replace the placeholder email, then run the whole file.
-- The last two columns mirror the rule in lib/services/investment-intelligence/caseLifecycle.ts.

with target as (
  select id as user_id
  from auth.users
  where lower(email) = lower('REPLACE_WITH_ACCOUNT_EMAIL')
),
docs as (
  select
    d.id,
    d.status as document_status,
    d.original_filename,
    (d.storage_path is not null and d.storage_purged_at is null) as file_stored,
    exists (select 1 from ii_holding_snapshots s where s.source_document_id = d.id) as has_holdings,
    exists (select 1 from ii_transactions x where x.source_document_id = d.id) as has_transactions
  from ii_source_documents d
  join target t on t.user_id = d.user_id
),
open_cases as (
  select c.id, c.discrepancy_type, c.severity, c.status, c.opened_at, c.source_document_id
  from ii_reconciliation_cases c
  join target t on t.user_id = c.user_id
  where c.status in ('open', 'user_reviewing')
)
select
  oc.discrepancy_type,
  oc.severity,
  dd.document_status,
  coalesce(dd.file_stored, false) as file_stored,
  coalesce(dd.has_holdings or dd.has_transactions, false) as data_retained,
  count(*) as open_cases,
  min(oc.opened_at) as oldest_opened,
  case
    when oc.discrepancy_type in ('owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required') then 'owner selection'
    when oc.discrepancy_type = 'ambiguous_instrument' then 'instrument resolution'
    when oc.discrepancy_type = 'transaction_unclassified' then 'transaction classification'
    when oc.discrepancy_type in ('cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict') then 'source conflict'
    when oc.discrepancy_type = 'document_password_required' and coalesce(dd.file_stored, false) then 'password and reprocess'
    when oc.discrepancy_type = 'document_password_required' then 'information no longer exists'
    when oc.discrepancy_type in ('unsupported_document', 'document_corrupt', 'parse_incomplete') then 'corrected file'
    when oc.discrepancy_type in ('transaction_missing_from_restatement', 'other', 'ai_fallback_reconciliation_attempted') then 'informational'
    when coalesce(dd.file_stored, false) then 'structured evidence'
    else 'information no longer exists'
  end as what_it_really_needs,
  case
    when oc.discrepancy_type in ('owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required') then 'choose the owner in Review'
    when oc.discrepancy_type = 'ambiguous_instrument' then 'choose the instrument in Review (applying it needs a replacement copy if the file is gone)'
    when oc.discrepancy_type = 'transaction_unclassified' then 'classify the transaction in Review'
    when oc.discrepancy_type in ('cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict') then 'choose which record to keep in Review'
    when oc.discrepancy_type = 'document_password_required' and coalesce(dd.file_stored, false) then 'enter the password and process'
    when oc.discrepancy_type in ('document_password_required', 'unsupported_document', 'document_corrupt', 'parse_incomplete') then 'upload a replacement copy or close as stale'
    when oc.discrepancy_type in ('transaction_missing_from_restatement', 'other', 'ai_fallback_reconciliation_attempted') then 'acknowledge only'
    when coalesce(dd.file_stored, false) then 'mark resolved after checking the retained figures'
    else 'mark resolved, upload a replacement copy, or close as stale'
  end as action_offered
from open_cases oc
left join docs dd on dd.id = oc.source_document_id
group by oc.discrepancy_type, oc.severity, dd.document_status, coalesce(dd.file_stored, false), coalesce(dd.has_holdings or dd.has_transactions, false)
order by open_cases desc, oc.discrepancy_type;
