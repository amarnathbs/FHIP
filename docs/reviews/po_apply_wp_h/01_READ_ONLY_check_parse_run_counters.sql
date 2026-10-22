-- WP-H pack 01 (READ ONLY, run on DEV first and then on production). Changes nothing.
-- Why: every statement processing run is closed with three counters that migration 0159 added.
-- Where they are missing, DEV was found without them on 21-10-2026, the run could not be closed
-- and a Reprocess or replacement copy within ten minutes was answered with already being processed.
-- The application now copes, but the screen summary of new, skipped and not found transactions needs them.

-- Result 1: expect three rows. Fewer rows means migration 0159 is not applied here.
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'ii_document_parse_runs'
  and column_name in ('duplicate_transactions_linked', 'new_transactions_count', 'missing_transactions_count')
order by column_name;

-- Result 2: the allowed discrepancy types. Expect the definition to contain transaction_missing_from_restatement.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.ii_reconciliation_cases'::regclass
  and conname = 'ii_reconciliation_cases_discrepancy_type_check';

-- Result 3: processing runs still marked queued or running after ten minutes. Expect none. Any row is a run that never closed.
select id, source_document_id, run_status, started_at
from ii_document_parse_runs
where run_status in ('queued', 'running')
  and started_at < now() - interval '10 minutes'
order by started_at
limit 50;
