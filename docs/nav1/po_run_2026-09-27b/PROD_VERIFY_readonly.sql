-- NAV 1 PO decision #1 -- read-only verification, run after applying
-- PROD_APPLY_0220_0221_0222.sql and after the code deploy. Every statement
-- here is a SELECT; nothing here writes.

-- V1: the two daily-NAV jobs now fire every day (day-of-week field is '*').
select jobname, schedule, active
from cron.job
where jobname in ('pc6-reference-ingest', 'pc6-reference-ingest-0400')
order by jobname;
-- Expect: schedule = '30-58/2 3 * * *' and '0-30/2 4 * * *' respectively (NOT '... 2-6').

-- V2: the weekly scheme-master job is unchanged (still Tuesday-only).
select jobname, schedule, active from cron.job where jobname = 'pc6-scheme-master-weekly';
-- Expect: schedule = '0-28/2 3 * * 2'.

-- V3: the reconciliation window exists, every day, 10:00-10:16 UTC.
select jobname, schedule, active, command from cron.job where jobname = 'pc6-nav-reconciliation';
-- Expect: schedule = '0-16/2 10 * * *'; command references /cron/pc6-nav-reconciliation
-- and "jobKey":"pc6_amfi_daily_nav_reconciliation".

-- V4: the reconciliation job's own control row, enabled.
select job_key, enabled, disabled_reason, last_success_at, last_failure_at, consecutive_failures
from ii_reference_job_control
where job_key = 'pc6_amfi_daily_nav_reconciliation';
-- Expect: enabled = true, disabled_reason is null (immediately after apply, before the first tick).

-- V5: the new tables exist and are empty immediately after apply.
select count(*) as coverage_rows from ii_reference_publication_coverage;
select count(*) as alert_rows from ii_reference_coverage_alerts;
-- Expect: 0 and 0 immediately after apply; both should start filling in from the
-- next 10:00 UTC tick onward.

-- V6: batch_kind accepts the new value (run once the first reconciliation
-- batch has actually written something -- otherwise this returns 0 rows,
-- which is fine before the first real gap is found).
select id, batch_kind, status, started_at, finished_at, rows_inserted, rows_superseded, error_code
from ii_reference_import_batches
where batch_kind = 'nav_reconciliation'
order by started_at desc
limit 20;

-- === Run once a day or more has passed with the schedule live ===

-- V7: coverage history and current state.
select source_config_id, publication_date, expected_count, present_count, missing_count, complete, last_checked_at
from ii_reference_publication_coverage
order by publication_date desc
limit 10;

-- V8: any open coverage alert (the queryable "coverage_alert" row the brief asks for).
select source_config_id, publication_date, expected_count, present_count, coverage_ratio, baseline_present_count, detail, created_at
from ii_reference_coverage_alerts
where resolved_at is null
order by created_at desc;
-- Expect: normally empty. A row here means expected coverage was materially
-- below the recent baseline after the day's most recent reconciliation sweep
-- -- worth a look, not necessarily a production incident (e.g. an unusually
-- early check before AMFI has finished publishing that day).
