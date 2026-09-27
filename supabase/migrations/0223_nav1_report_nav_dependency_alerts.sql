-- NAV 1 -- PO decision #6 (2026-09-27 dispatch): a finalized report's NAV
-- dependency later becoming missing must fail closed, not silently
-- recalculate.
--
-- WHAT ALREADY EXISTS (verified by reading the code, not assumed). Module 9
-- finalized reports (`reports` / `report_sections`) already store FROZEN
-- output (`report_sections.section_data_json`, written once at generation
-- in lib/services/reportsData.ts, never recomputed on view -- getReport()
-- and getReportByRenderToken() only ever SELECT). Regeneration already goes
-- through a real, working version chain: `reports.version_number`,
-- `revises_report_id`, `status='superseded'` -- a revision always inserts a
-- NEW row and marks the old one superseded; it never overwrites in place
-- (lib/services/reportsData.ts, app/api/reports/[id]/retry/route.ts, .../
-- revise/route.ts). `ii_report_nav_dependencies` (0172) already protects a
-- pinned range from Stage-E deletion. So PO decision #6(a), (c) and (e) are
-- already true for the existing mechanism. This migration adds the piece
-- that is genuinely missing: (b) a queryable alert when a dependency a
-- report already relied on no longer resolves, feeding (f) exclusion from
-- any future cleanup logic (already true via 0219's coverage-gap check on
-- the same instrument, and via 0172/0200's own report-pin check).
--
-- SELF-CONTAINED NAMING. No other "coverage_alert"/"integrity_alert" table
-- exists anywhere in the repository as of this migration (checked across
-- every migration file and the whole codebase) -- named
-- ii_report_nav_dependency_alerts, specific enough not to collide with a
-- concurrently developed, differently scoped alert mechanism from another
-- dispatch. Re-check before applying if that dispatch has landed since.
--
-- WHAT THIS DOES NOT DO. It does not recompute or alter any report. It does
-- not attempt restoration itself (see scripts/
-- nav1_report_dependency_restoration_attempt.ts for that, run separately
-- and only by an authorized operator). It is a detector and a ledger only.
--
-- Verification: scripts/nav1_0223_pglite_verification.mjs.

create table if not exists ii_report_nav_dependency_alerts (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  report_nav_dependency_id uuid references ii_report_nav_dependencies(id) on delete set null,
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  basis text not null,
  nav_date_from date,
  nav_date_to date not null,
  rows_found integer not null,
  rows_expected_nonzero boolean not null default true,
  detail text not null,
  detected_at timestamptz not null default now(),
  detected_by text not null,
  resolved_at timestamptz,
  resolution_report_id uuid references reports(id),
  resolution_detail text,
  created_at timestamptz not null default now(),
  constraint ii_report_nav_dependency_alerts_range check (nav_date_from is null or nav_date_from <= nav_date_to)
);

-- One open alert per (report, instrument, basis) -- a re-check must not
-- pile up duplicate alerts for the same still-broken dependency; a genuinely
-- NEW break after a resolved one gets its own row (matches the
-- ii_nav_retention_holds / 0171 "re-open vs extend" idiom used elsewhere in
-- this programme).
create unique index if not exists idx_ii_report_nav_dependency_alerts_open_dedup
  on ii_report_nav_dependency_alerts(report_id, instrument_id, basis) where resolved_at is null;
create index if not exists idx_ii_report_nav_dependency_alerts_instrument
  on ii_report_nav_dependency_alerts(instrument_id) where resolved_at is null;
create index if not exists idx_ii_report_nav_dependency_alerts_report
  on ii_report_nav_dependency_alerts(report_id);

alter table ii_report_nav_dependency_alerts enable row level security;
drop policy if exists "admin read ii_report_nav_dependency_alerts" on ii_report_nav_dependency_alerts;
create policy "admin read ii_report_nav_dependency_alerts" on ii_report_nav_dependency_alerts
  for select using (is_pc6_reference_data_admin());

comment on table ii_report_nav_dependency_alerts is
  'NAV 1 (0223), PO decision #6(b). Raised by checkReportNavDependencyIntegrity() '
  '(lib/services/investment-intelligence/pc6/reportNavDependencyIntegrity.ts) when a finalized report''s '
  'own recorded NAV dependency (ii_report_nav_dependencies) no longer has the NAV coverage it had when '
  'the report was generated -- e.g. rows in its date range were deleted by a bug or a bypassed '
  'retention predicate. Detector only: never recalculates the report, never edits report_sections. '
  'Admin-read-only via RLS; written only by service-role application code.';
comment on column ii_report_nav_dependency_alerts.rows_found is
  'NAV row count actually present for (instrument_id, [nav_date_from or the earliest available date, '
  'nav_date_to]) at detection time. A bounded check (endpoints + a nonzero-count check), not an exact '
  'per-date reconciliation -- see the detector''s own header for what it can and cannot catch.';
comment on column ii_report_nav_dependency_alerts.resolution_report_id is
  'If a NEW report version was generated to disclose or work around the gap (never to silently replace '
  'the original), its id -- per PO decision #6(e): a regenerated version is a new report, never an '
  'overwrite of the original.';
