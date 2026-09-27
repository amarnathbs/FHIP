-- NAV 1 -- PO decision #1 (27 Sep 2026), part 2 of 3: the reconciliation
-- sweep's own tables (lib/services/investment-intelligence/pc6/
-- navReconciliationSweep.ts), its batch kind, and its job-control row.
--
-- WHAT THIS ADDS.
--   1. ii_reference_publication_coverage -- one row per (source, publication
--      date): expected vs present counts, confirmed AGAINST WHAT THE SOURCE
--      ITSELF PUBLISHED for that date (never a static "every mapped
--      instrument" universe -- see navReconciliationSweep.ts's header for why
--      that measure is permanently ~40% short and unusable here), and the
--      `complete` flag the PO's brief asks for: true ONLY once a
--      reconciliation sweep has confirmed zero gap, never merely because the
--      main collection window finished.
--   2. ii_reference_coverage_alerts -- the "queryable coverage_alert style
--      row the operator can check" the brief asks for, since this repository
--      has no external alerting system. One OPEN (resolved_at is null) row
--      per (source, publication date); it self-resolves (resolved_at set)
--      once a later sweep finds coverage has recovered.
--   3. 'nav_reconciliation' added to the batch_kind CHECK -- a STRICT
--      SUPERSET of 0192's list (0157's six values + 'fund_holdings_disclosure'
--      + 'nav_hydration'), so a recreated constraint can never silently
--      narrow what was already accepted. scripts/nav1_0221_pglite_verification.mjs
--      derives the predecessor from the migration ledger and asserts this
--      (same discipline as 0192, applying the lesson from
--      migration_drop_recreate_constraint_trap).
--   4. A dedicated ii_reference_job_control row, 'pc6_amfi_daily_nav_reconciliation'
--      -- its OWN kill switch/backoff/last_success_at, independent of the main
--      daily job's row, so disabling one never touches the other. The SAME
--      row is reused, unmodified, by the one-off backfill
--      (docs/nav1/po_run_2026-09-27b/), since the backfill is exactly this
--      sweep pointed at a past date via the AMFI history endpoint rather than
--      "today" -- see navReconciliationSweep.ts's header.
--
-- ACCESS. Global reference-data telemetry about a public source, never a
-- user's own data (D.1/D.7 boundary, same as every other ii_reference_*
-- table since 0155): admin-read via the existing is_pc6_reference_data_admin()
-- capability, service-role write only.
--
-- SHIPS ENABLED. Unlike 0155's original job-control rows (which shipped
-- disabled under a now-superseded "no autonomous activation" binding
-- override for this specific mission), this row ships enabled = true: PO
-- decision #1 IS the authorization to run this job, and this migration is
-- itself a PO-run production file (docs/nav1/po_run_2026-09-27b/), not an
-- autonomous activation.
--
-- Verification: scripts/nav1_0221_pglite_verification.mjs.

-- ===========================================================================
-- 1. ii_reference_publication_coverage
-- ===========================================================================
create table if not exists ii_reference_publication_coverage (
  id uuid primary key default gen_random_uuid(),
  source_config_id text not null,
  publication_date date not null,
  expected_count integer not null check (expected_count >= 0),
  present_count integer not null check (present_count >= 0),
  missing_count integer not null check (missing_count >= 0),
  complete boolean not null default false,
  last_checked_at timestamptz not null,
  last_sweep_batch_id uuid references ii_reference_import_batches(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ii_reference_publication_coverage_present_le_expected check (present_count <= expected_count),
  unique (source_config_id, publication_date)
);
create index if not exists idx_ii_reference_publication_coverage_incomplete
  on ii_reference_publication_coverage(source_config_id, publication_date desc) where not complete;
alter table ii_reference_publication_coverage enable row level security;
drop policy if exists "admin read ii_reference_publication_coverage" on ii_reference_publication_coverage;
create policy "admin read ii_reference_publication_coverage" on ii_reference_publication_coverage
  for select using (is_pc6_reference_data_admin());
comment on table ii_reference_publication_coverage is
  'NAV 1 reconciliation sweep (0221). One row per (source, publication date). complete=true ONLY once a reconciliation sweep has confirmed zero gap against what the source itself published for that date -- never merely because the collection window finished. "Expected" is derived from the source''s own file for that date, never a static instrument universe (see navReconciliationSweep.ts header for why).';
comment on column ii_reference_publication_coverage.complete is
  'Set exclusively by navReconciliationSweep.ts. A window can succeed (referenceIngestJob.ts) on a day the source later republishes more schemes (F-18) -- window success never implies this is true.';

-- ===========================================================================
-- 2. ii_reference_coverage_alerts -- the queryable "coverage_alert" row.
--    No external alerting system exists in this repository (N.15 alerting is
--    otherwise carried only in a batch's own alerts[] returned to the HTTP
--    caller, which nothing currently persists or watches). This table is
--    what an operator queries: `select * from ii_reference_coverage_alerts
--    where resolved_at is null`.
-- ===========================================================================
create table if not exists ii_reference_coverage_alerts (
  id uuid primary key default gen_random_uuid(),
  source_config_id text not null,
  publication_date date not null,
  expected_count integer not null check (expected_count >= 0),
  present_count integer not null check (present_count >= 0),
  coverage_ratio numeric,
  baseline_present_count numeric,
  baseline_ratio_threshold numeric not null,
  detail text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_detail text
);
-- At most one OPEN alert per (source, publication date) -- a later sweep the
-- same day updates it in place rather than piling up duplicates.
create unique index if not exists uidx_ii_reference_coverage_alerts_open
  on ii_reference_coverage_alerts(source_config_id, publication_date) where resolved_at is null;
create index if not exists idx_ii_reference_coverage_alerts_created on ii_reference_coverage_alerts(created_at desc);
alter table ii_reference_coverage_alerts enable row level security;
drop policy if exists "admin read ii_reference_coverage_alerts" on ii_reference_coverage_alerts;
create policy "admin read ii_reference_coverage_alerts" on ii_reference_coverage_alerts
  for select using (is_pc6_reference_data_admin());
comment on table ii_reference_coverage_alerts is
  'NAV 1 reconciliation sweep (0221). Queryable stand-in for external alerting (none exists in this repository): a row here means expected coverage was materially below the recent baseline after the day''s most recent reconciliation sweep. Self-resolves (resolved_at set) once a later sweep finds coverage recovered.';

-- ===========================================================================
-- 3. batch_kind: add 'nav_reconciliation'. Strict superset of 0192's list.
-- ===========================================================================
alter table ii_reference_import_batches drop constraint if exists ii_reference_import_batches_batch_kind_check;
alter table ii_reference_import_batches
  add constraint ii_reference_import_batches_batch_kind_check
  check (batch_kind in (
    'scheme_master',
    'daily_nav',
    'nav_history',
    'benchmark_level',
    'risk_free_rate',
    'fund_holdings_disclosure',
    'nav_hydration',
    -- NAV 1 reconciliation sweep (this migration). One batch == one sweep
    -- invocation that found a real gap and wrote to fill it; a sweep that
    -- finds nothing missing opens no batch at all (see
    -- navReconciliationSweep.ts, "complete_no_gap").
    'nav_reconciliation'
  ));

-- ===========================================================================
-- 4. Job control row for the reconciliation sweep, and the one-off backfill
--    that reuses it. Fails closed like every other PC6 job if this row is
--    ever deleted (referenceImportRunner.decideStart()).
-- ===========================================================================
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_amfi_daily_nav_reconciliation', true, null
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation');
