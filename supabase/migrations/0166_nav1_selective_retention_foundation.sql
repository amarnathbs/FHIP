-- NAV 1 (FHIP NAV sourcing and retention, master execution prompt v1,
-- 21 September 2026) — selective-retention foundation.
--
-- Forward-only, additive, and idempotent end to end (every statement is
-- guarded), so it is safe to re-run.
--
-- MIGRATION NUMBER FRESHNESS. Checked 2026-09-21 across every remote branch
-- (150+ scanned), taking the MAXIMUM of:
--   1. this branch's supabase/migrations (built off origin/main)  -> 0164
--   2. origin/main's supabase/migrations                          -> 0164
--   3. every other remote branch's supabase/migrations            -> 0165
--      (origin/feature/admin-a2-a5-master-execution:
--       0165_admin_a4_canonical_audit_and_security_event_sink.sql)
--   4. supabase_migrations.schema_migrations on DEV/production     -> not
--      independently queried this session (no live DB credentials in this
--      sandbox — see docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md,
--      NAV 1.02/1.05, marked BLOCKED). Re-run
--      scripts/check-migration-versions-against-branch.mjs and confirm the
--      live schema_migrations ledger before actually applying this file.
-- 0166 is the next free number given (1)-(3); it has not been independently
-- re-confirmed against (4).
--
-- APPLICATION STATUS: NOT APPLIED anywhere. This is a hand-over artefact for
-- an operator with DEV/production dashboard or CLI access to review and
-- apply — this session has no DDL path to either database (consistent with
-- every prior PC6/NAV migration in this programme).
--
-- BOUNDARY. Everything created here is EXTERNAL REFERENCE / OPERATIONAL
-- data (job control, policy configuration, cleanup-concurrency holds).
-- Nothing here touches a user's transactions, holdings, or reports, and
-- nothing here performs or schedules any deletion — Stage E (controlled
-- historical deletion, NAV 1.43) is a SEPARATE, later, explicitly
-- authorized change, not part of this migration.

-- ===========================================================================
-- 1. Safe pause (NAV 1.03). A kill switch for the brute-force full-universe
--    backfill script, which has no kill switch today (it is a hand-run
--    script, not the scheduled job 0155 already controls). Ships DISABLED:
--    the redesigned architecture replaces this path with selective
--    hydration (below), and re-enabling brute-force backfill should be a
--    deliberate, reasoned, one-invocation exception, never a default.
-- ===========================================================================
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_full_universe_historical_backfill', false,
       'NAV 1 (2026-09-21): the full-universe brute-force historical backfill this key gates grew ' ||
       'production ii_prices_nav to 6.26GB+ of a 12GB disk by fetching NAV history for every resolvable ' ||
       'AMFI-universe instrument, not merely held/dependency schemes (the PC6 scheme-master expansion ' ||
       'means "resolvable" now means essentially the whole ~14,358-scheme AMFI catalogue). Superseded by ' ||
       'pc6_selective_historical_hydration below. Ships disabled by design; scripts/pc6_historical_nav_backfill.mjs ' ||
       'now refuses to run at all unless this row is explicitly re-armed.'
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_full_universe_historical_backfill');

-- ===========================================================================
-- 2. Separate historical/daily scheduling (NAV 1.04). A distinct job key for
--    the NEW selective hydration path, so it can be governed, monitored and
--    enabled/disabled independently of both the (superseded) full-universe
--    backfill above and the existing pc6_amfi_daily_nav all-live daily feed
--    (0155), which this migration does NOT touch — daily collection must
--    keep running/be activatable on its own timeline regardless of
--    historical cleanup or hydration state (workbook requirement 1/7).
-- ===========================================================================
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_selective_historical_hydration', false,
       'Ships DISABLED. Per this programme''s binding override, no production schedule may be activated ' ||
       'by an autonomous agent; enabling is a deferred human-present step once NAV 1.26 (initial historical ' ||
       'hydration) is built, DEV-verified, and the dependency-resolution query (accepted statements + ' ||
       'benchmark mappings) is live-proven.'
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_selective_historical_hydration');

-- ===========================================================================
-- 3. ii_nav_retention_policy — the policy version and changeover date record
--    (NAV 1.07). "A deployment timestamp and a NAV date are different
--    values" — activated_at is when this policy version took effect
--    operationally; changeover_date (C) is the financial date boundary
--    itself. Effective-dated so a future policy change is auditable rather
--    than an in-place overwrite of what C used to be.
-- ===========================================================================
create table if not exists ii_nav_retention_policy (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null unique,
  -- Indian financial date from which all-live forward daily collection is
  -- authoritative and protected regardless of holdings (PO decision, this
  -- programme, 2026-09-21).
  changeover_date date not null,
  environment text not null check (environment in ('dev', 'production')),
  activated_at timestamptz not null default now(),
  activated_by_admin_id uuid,
  coverage_proof_reference text,
  notes text,
  created_at timestamptz not null default now()
);
alter table ii_nav_retention_policy enable row level security;
drop policy if exists "admin read ii_nav_retention_policy" on ii_nav_retention_policy;
create policy "admin read ii_nav_retention_policy" on ii_nav_retention_policy
  for select using (is_pc6_reference_data_admin());
comment on table ii_nav_retention_policy is
  'NAV 1.07. One row per policy version per environment. Seeded empty by this migration -- activation
  (inserting the DEV row with changeover_date = 2026-09-21) is a separate, explicit NAV 1.07 closure step,
  not assumed by mere table creation.';

-- ===========================================================================
-- 4. ii_nav_retention_holds — race prevention (workbook "Race prevention":
--    "If a new upload becomes accepted during cleanup, its required history
--    must remain protected or be restored before analytics can claim
--    readiness."). A hold is instrument-scoped (never row-scoped) and must
--    be checked by BOTH the candidate-manifest dry run (NAV 1.42) and any
--    actual deletion batch (NAV 1.43) immediately before acting, not merely
--    at manifest-build time -- "a stale candidate manifest cannot override
--    current eligibility".
-- ===========================================================================
create table if not exists ii_nav_retention_holds (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  reason text not null check (reason in (
    'statement_upload_in_progress', 'statement_reconciliation_in_progress',
    'cleanup_batch_in_progress', 'manual_admin_hold'
  )),
  created_by_admin_id uuid,
  created_at timestamptz not null default now(),
  -- A hold is transient by construction: NULL expires_at means "held until
  -- explicitly released", never "held forever by accident".
  expires_at timestamptz,
  released_at timestamptz
);
create index if not exists idx_ii_nav_retention_holds_active
  on ii_nav_retention_holds(instrument_id) where released_at is null;
alter table ii_nav_retention_holds enable row level security;
drop policy if exists "admin read ii_nav_retention_holds" on ii_nav_retention_holds;
create policy "admin read ii_nav_retention_holds" on ii_nav_retention_holds
  for select using (is_pc6_reference_data_admin());
comment on table ii_nav_retention_holds is
  'NAV 1.39/1.42 race prevention. Deliberately EMPTY seed -- no hold is active until a real concurrent
  operation registers one. This table protects an INSTRUMENT (not individual NAV rows), matching the
  workbook''s own "a dependency can protect a range or an entire scheme... document that choice" -- this
  migration documents the choice as whole-instrument.';

-- ===========================================================================
-- 5. Read-only helper: is this (instrument, price_date) pair currently a
--    CANDIDATE under the policy contract, evaluated live against today's
--    schema state. Mirrors lib/services/investment-intelligence/pc6/
--    navRetentionPolicy.ts's evaluateCandidate() -- the two are NOT the same
--    source file and must be kept in sync deliberately (documented in both
--    places). This function is SELECT-only-safe: it performs no writes and
--    is the basis for scripts/pc6_nav1_retention_dryrun_manifest.sql. It is
--    NOT wired into any trigger, cron job, or deletion path by this
--    migration -- Stage E execution remains a separate authorization.
--
--    pinned_by_report_or_revision(row) has NO real binding yet (see
--    navRetentionPolicy.ts header and NAV1_PROGRESS_LEDGER.md, NAV 1.35) --
--    this function therefore fails CLOSED for that predicate, i.e. it never
--    treats "no report-pin mechanism exists" as "no report dependency
--    exists". A row is only a genuine DELETE candidate once that gap is
--    closed for real, not merely worked around here.
-- ===========================================================================
create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $$
  select not (
    p_price_date >= p_changeover_date
    or exists (
      -- needed_by_accepted_statement_history: any certified statement for
      -- this instrument, with the retained window driven by
      -- history_completeness.
      select 1
      from ii_portfolio_truth_status pts
      where pts.instrument_id = p_instrument_id
        and pts.status in ('certified', 'certified_with_warnings')
        and (
          pts.history_completeness is null -- not yet evaluated: hold conservatively
          or pts.history_completeness = 'complete_from_inception'
          or (
            pts.history_completeness = 'complete_from_known_opening_balance'
            and p_price_date >= coalesce(
              (select min(t.transaction_date) from ii_transactions t
               where t.instrument_id = pts.instrument_id and t.account_id = pts.account_id and t.status <> 'reversed'),
              p_price_date -- no transaction found: do not falsely exclude, hold this date too
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
      -- needed_by_benchmark_dependency: ever mapped, current or historical.
      select 1 from ii_instrument_benchmarks ib where ib.instrument_id = p_instrument_id
    )
    or false -- pinned_by_report_or_revision: fails CLOSED (see header) -- always protects until wired
    or exists (
      -- protected_by_active_hold
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
  );
$$;
comment on function pc6_nav_row_is_candidate is
  'NAV 1.07/1.12/1.42 policy contract, bound to real schema. SELECT-only; performs no writes. The
  pinned_by_report_or_revision term always returns protected (fails closed) until a real report-pin
  mechanism exists -- see the function body and navRetentionPolicy.ts.';
