-- WP-H3 pack 06 (READ ONLY). Run after pack 05, then press Re-evaluate all positions in the app and run this again.
-- Result 1 must be empty: no group of repeated lines is left. Result 2 lists what was retired. Result 3 shows how many of the backed up
-- rows are still counted: for the retired rows it must be zero.

-- Result 1
with groups as (
  select t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount
  from ii_transactions t
  where t.status <> 'reversed' and t.source_reference is null and t.source_document_id is not null
  group by t.user_id, t.account_id, t.instrument_id, t.source_document_id, t.transaction_date, t.gross_amount
  having count(*) > 1 and count(distinct t.parse_run_id) > 1
)
select * from groups order by transaction_date;

-- Result 2
select
  e.created_at, e.subject_id as retired_transaction_id, e.metadata ->> 'kept_transaction_id' as kept_transaction_id, e.metadata ->> 'retired' as retired_which
from ii_audit_events e
where e.event_type = 'admin_correction' and e.metadata ->> 'kind' = 'wph3_duplicate_retired'
order by e.created_at desc
limit 100;

-- Result 3
select
  count(*) as retired_rows_in_backup,
  count(*) filter (where t.status <> 'reversed') as still_counted
from ii_transactions_backup_wph3_20261025 b
join ii_transactions t on t.id = b.id
where b.id in (
  select e.subject_id from ii_audit_events e where e.event_type = 'admin_correction' and e.metadata ->> 'kind' = 'wph3_duplicate_retired'
);
