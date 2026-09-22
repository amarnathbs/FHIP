-- NAV 1 — R1: report pinning / reproducibility manifest, schema half.
--
-- Forward-only, additive, idempotent.
--
-- MIGRATION NUMBER FRESHNESS. Checked 2026-09-21 (5th continuation
-- dispatch), same scan as 0171's header: 0172 is free across all 150
-- scanned remote branches at the time of writing.
--
-- APPLICATION STATUS: NOT APPLIED anywhere (DEV or production). Hand-over
-- artefact -- no DDL path from this session to DEV or production.
--
-- WHAT THIS DOES AND DOES NOT DO -- read this before assuming R1 is fully
-- closed. It ships:
--   (a) a new table, ii_report_nav_dependencies, to hold a COMPACT RANGE
--       manifest (instrument_id, [nav_date_from, nav_date_to]) per
--       finalized report, keyed to the report's own row (cascade-deleted
--       with it, matching every other Module 9 child table's lifecycle);
--   (b) a rewire of pc6_nav_row_is_candidate()'s pinned_by_report_or_revision
--       predicate from 0171's interim `or true` (fail closed, maximally
--       conservative, protects EVERYTHING) to a real, narrower EXISTS
--       check against this table.
-- It does NOT wire any report-generation code to actually WRITE into this
-- table yet -- lib/services/investment-intelligence/pc6/
-- reportNavDependencyManifest.ts (this dispatch) provides the pure,
-- unit-tested computation a future integration pass can call from
-- lib/services/reportsData.ts's report-finalization path, but that call
-- site edit is deliberately NOT made this dispatch (see that file's own
-- header for why: reportsData.ts is a live, security-hardened,
-- already-certified financial-reporting path that deserves its own
-- dedicated, live-verified integration pass, not a same-dispatch add-on
-- with no remaining budget to prove it end-to-end).
--
-- CONSEQUENCE OF THIS SEQUENCING, STATED PLAINLY: until that write-path is
-- wired, this table stays EMPTY in every real environment, which means
-- pinned_by_report_or_revision will evaluate to FALSE for every row (no
-- report manifest exists to match) -- i.e. this migration, on its own,
-- REMOVES 0171's blanket fail-closed protection and replaces it with "no
-- protection from this predicate at all" until the write-path exists.
-- This is a DELIBERATE, DISCLOSED trade-off, not an oversight: NAV 1.42's
-- own dry-run manifest and any real NAV 1.43 deletion MUST NOT be treated
-- as safe with respect to report-pinning until the write-path integration
-- lands and has been live-verified to actually populate this table for
-- real finalized reports -- this migration's own comment on
-- pc6_nav_row_is_candidate() states this explicitly, and NAV1_PROGRESS_LEDGER.md
-- records it as an open item, not a closed one. A future migration or
-- runbook step should NOT re-enable a blanket `or true` fallback merely to
-- "be safe" once this table exists, because that would make this table's
-- real, narrower protection meaningless (everything permanently pinned
-- again) -- the correct next step is the write-path integration itself,
-- not another placeholder.
--
-- DESIGN CHOICE (workbook Option C, narrowed further -- see
-- reportNavDependencyManifest.ts's own header for the full rationale):
-- a RANGE manifest, not a full per-row (instrument_id, price_date,
-- revision) audit trail (workbook Option A). This is sufficient to make
-- NAV 1's own Stage-E candidate selection correctly exclude every NAV row
-- a finalized report is known to depend on -- the specific, narrower
-- requirement THIS programme's own fail-closed gap actually needs closed
-- -- but does NOT by itself guarantee byte-identical report reproduction
-- after a NAV *value* correction (an already-narrower, separate concern:
-- Module 9's own report_sections already store FROZEN, already-computed
-- aggregate numbers -- see NAV1_PROGRESS_LEDGER.md Priority 6 -- so a
-- rendered report does not silently change even without this table; the
-- open risk this table protects against is specifically DELETION of NAV
-- rows a report might need if it is ever genuinely REGENERATED).
--
-- LEGACY-REPORT TREATMENT (workbook 4.6): existing, already-finalized
-- reports (every `reports` row created before this migration exists) have
-- NO manifest row and never will retroactively (backfilling exact
-- dependencies for old reports by guessing which NAV rows they used would
-- be exactly the kind of fabrication this programme's N.8 principle
-- forbids). Per 4.6's own menu of choices, this migration adopts: legacy
-- reports are treated as IMMUTABLE OUTPUT-ONLY SNAPSHOTS -- since Module 9
-- already stores frozen aggregate numbers (not live NAV re-reads) in
-- report_sections.section_data_json, an old report's DISPLAY is genuinely
-- safe regardless of this table. What is NOT safe, and remains an open,
-- disclosed limitation: a legacy report can no longer prove which exact
-- NAV rows it depended on if it is ever REGENERATED (revision_reason flow)
-- after Stage E cleanup has run. This migration does not attempt a
-- temporary blanket hold for every legacy report either, because
-- `reports` already has hundreds of real rows (932 report_snapshots
-- observed live in DEV, NAV1_PROGRESS_LEDGER.md Priority 6) spanning an
-- unknown, unenumerated set of instruments -- adding a hold for "every
-- instrument any legacy report might ever reference" would be
-- functionally identical to never allowing Stage E to run at all, which is
-- a real Product Owner decision (accept the residual regeneration risk vs.
-- block cleanup indefinitely for legacy reports), not one this migration
-- may make unilaterally. Recorded here as an explicit, named open decision
-- for NAV 1.43/Stage-E authorization, not silently resolved.
-- ===========================================================================

create table if not exists ii_report_nav_dependencies (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  report_snapshot_id uuid references report_snapshots(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  basis text not null check (basis in (
    'xirr_since_inception', 'twr_since_opening_balance', 'rolling_return_window',
    'sip_xray_transaction_history', 'tax_lot_fifo', 'other'
  )),
  -- NULL means "no lower bound -- protect from true inception", the same
  -- idiom ii_nav_retention_holds.expires_at already uses for "no upper
  -- bound" (0166). Never interpret NULL here as "unknown, so ignore".
  nav_date_from date,
  nav_date_to date not null,
  created_at timestamptz not null default now(),
  constraint ii_report_nav_dependencies_valid_range check (nav_date_from is null or nav_date_from <= nav_date_to)
);
-- Idempotent retry of the SAME report-finalization write (workbook 4.7 test
-- 3: "the same report finalization request is idempotent") -- a retry must
-- upsert, not duplicate. Scoped per (report, instrument, basis): a report
-- can legitimately have multiple bases per instrument (e.g. both
-- xirr_since_inception AND rolling_return_window for the same holding, if
-- the report shows both an XIRR figure and a rolling-return chart).
create unique index if not exists idx_ii_report_nav_dependencies_dedup
  on ii_report_nav_dependencies(report_id, instrument_id, basis);
-- The exact lookup shape pc6_nav_row_is_candidate() below needs.
create index if not exists idx_ii_report_nav_dependencies_instrument_range
  on ii_report_nav_dependencies(instrument_id, nav_date_to);
create index if not exists idx_ii_report_nav_dependencies_report
  on ii_report_nav_dependencies(report_id);
alter table ii_report_nav_dependencies enable row level security;
drop policy if exists "admin read ii_report_nav_dependencies" on ii_report_nav_dependencies;
create policy "admin read ii_report_nav_dependencies" on ii_report_nav_dependencies
  for select using (is_pc6_reference_data_admin());
comment on table ii_report_nav_dependencies is
  'NAV 1 R1. A COMPACT RANGE manifest (not a full per-row audit trail -- see migration 0172 header and
  reportNavDependencyManifest.ts) of which (instrument_id, [nav_date_from, nav_date_to]) a finalized
  report is known to depend on. Ships EMPTY until lib/services/reportsData.ts''s report-finalization
  path is wired to write into it (NOT done by this migration -- see header). Admin-read-only via RLS;
  written only by service-role application code, never directly by a user.';

-- ===========================================================================
-- Rewire pc6_nav_row_is_candidate(): replace 0171's interim `or true`
-- fail-closed placeholder with a real, narrower EXISTS check against the
-- new manifest table. See this migration's own header for the disclosed
-- consequence (the table currently ships empty, so this predicate
-- currently contributes no protection in practice until the write-path is
-- wired) -- this is a DELIBERATE narrowing, not a silent regression: it
-- replaces a placeholder that was never meant to be permanent with the
-- real mechanism the placeholder was standing in for.
-- ===========================================================================

create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $$
  select not (
    p_price_date >= p_changeover_date
    or exists (
      select 1
      from ii_portfolio_truth_status pts
      where pts.instrument_id = p_instrument_id
        and pts.status in ('certified', 'certified_with_warnings')
        and (
          pts.history_completeness is null
          or pts.history_completeness = 'complete_from_inception'
          or (
            pts.history_completeness = 'complete_from_known_opening_balance'
            and p_price_date >= coalesce(
              (select min(t.transaction_date) from ii_transactions t
               where t.instrument_id = pts.instrument_id and t.account_id = pts.account_id and t.status <> 'reversed'),
              p_price_date
            )
          )
          or (
            pts.history_completeness in ('partial_history', 'holdings_only')
            and p_price_date >= coalesce(
              (select hs.as_of_date from ii_holding_snapshots hs where hs.id = pts.latest_holding_snapshot_id),
              p_price_date
            )
          )
        )
    )
    or exists (
      select 1 from ii_instrument_benchmarks ib where ib.instrument_id = p_instrument_id
    )
    or exists (
      -- pinned_by_report_or_revision: REAL check as of 0172 (was 0171's
      -- interim `or true`; was 0166's original, buggy `or false`). A row
      -- is report-pinned if ANY ii_report_nav_dependencies manifest entry
      -- for this instrument covers this price_date. NULL nav_date_from
      -- means "no lower bound", matching this table's own documented
      -- idiom.
      select 1 from ii_report_nav_dependencies d
      where d.instrument_id = p_instrument_id
        and p_price_date <= d.nav_date_to
        and (d.nav_date_from is null or p_price_date >= d.nav_date_from)
    )
    or exists (
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
  );
$$;
comment on function pc6_nav_row_is_candidate is
  'NAV 1.07/1.12/1.42 policy contract, bound to real schema. SELECT-only; performs no writes.
  pinned_by_report_or_revision (as of migration 0172) is a REAL, narrow EXISTS check against
  ii_report_nav_dependencies -- see that table''s own comment and migration 0172''s header for the
  disclosed consequence that this table currently ships empty (write-path not yet wired) and the
  legacy-report open decision this migration records rather than resolves unilaterally.';
