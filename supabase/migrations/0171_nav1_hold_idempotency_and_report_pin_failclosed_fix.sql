-- NAV 1 — R3 (repeated-certification hold decision) + a genuine correctness
-- fix for 0166's report-pin predicate, found while investigating R3/R1.
--
-- Forward-only, additive, idempotent.
--
-- MIGRATION NUMBER FRESHNESS. Checked 2026-09-21 (5th continuation
-- dispatch): this branch's chain -> 0168; origin/main -> 0170
-- (0169_real_malware_scan_gate_columns.sql,
-- 0170_fdh3_structural_scan_error_code.sql -- an unrelated malware-gate
-- programme merged to main while this branch was in flight);
-- origin/fix/fdh3-structural-malware-validation-2026-09-21,
-- origin/fix/malware-scan-aws-creds-env-2026-09-21 and
-- origin/integration/pdf-upload-e2e-2026-09-21 all cap out at 0170 too.
-- Scanned ALL 150 remote branches for any 0169-0189 file; 0171 is the first
-- genuinely free number anywhere. This branch will need migrations 0169/0170
-- reconciled (not merely renumbered) when it is eventually rebased onto the
-- current origin/main -- flagged here, not silently worked around.
--
-- APPLICATION STATUS: NOT APPLIED anywhere (DEV or production). Hand-over
-- artefact -- no DDL path from this session to DEV or production
-- (re-confirmed fresh this dispatch, same constraint recorded by every prior
-- NAV1 migration).
--
-- ===========================================================================
-- PART A -- NAV 1 R3: repeated-certification hold decision.
--
-- THE QUESTION (from NAV1_PROGRESS_LEDGER.md, migration 0168's own live
-- functional test, 4th continuation): does a flapping
-- ii_portfolio_truth_status.status (certified -> certified_with_warnings ->
-- certified -> ...) legitimately deserve a brand-new
-- ii_nav_retention_holds row every time, or is that unwanted duplication?
--
-- THE DECISION, per this migration: NOT a meaningful independent audit
-- event while a hold from the SAME (instrument_id, reason) lineage is still
-- open (released_at is null). Rationale:
--   1. The hold's ENTIRE purpose (0166's own header) is race prevention --
--      "protect this instrument until the next selective-hydration run
--      picks up the dependency". A re-certification that happens while that
--      protection is already active does not change what needs protecting;
--      it is the SAME protection need, re-confirmed, not a new one.
--   2. It does not carry incremental audit value distinct from
--      ii_portfolio_truth_status's own history (that table, not this one,
--      is the correct place to see how many times a statement was
--      re-certified -- this table's job is "is this instrument currently
--      protected", not "how many times was it certified").
--   3. Leaving it unfixed is a genuine, if bounded, accumulation risk: a
--      statement that is corrected and re-certified repeatedly (a real,
--      plausible operational pattern -- see FS-Q06 in the existing FS1
--      suite, "reprocessing idempotency") would otherwise grow this table
--      without limit for a single real instrument, all rows saying the
--      exact same thing.
--   4. It MUST NOT prevent a genuinely NEW certification lifecycle (after a
--      release, or after an admin explicitly ends a hold) from getting its
--      own new, independent hold -- per this migration's own binding
--      instruction: "do not use a simplistic unique constraint that
--      prevents a legitimately new certification version from obtaining
--      protection." This is why the dedup key below is scoped to
--      "currently unreleased", not "ever existed for this instrument".
--
-- THE MECHANISM: a partial unique index on (instrument_id, reason) WHERE
-- released_at IS NULL, plus an ON CONFLICT ... DO UPDATE in the trigger that
-- EXTENDS (never shrinks) the existing open hold's expires_at instead of
-- inserting a duplicate row. Once a hold is released (released_at set, by
-- the existing manual-release lifecycle already proven live in NAV 1.39),
-- the partial index no longer matches it, so the NEXT certifying transition
-- correctly opens a brand-new, independent hold row -- satisfying
-- requirement 4 above by construction, not by a separate carve-out.
--
-- Pre-existing rows are unaffected: every row created by the ORIGINAL 0168
-- trigger (and NAV 1.39's manual test row) was already given released_at
-- (either by the 0168 functional test's own cleanup, or NAV 1.39's release
-- lifecycle) before this migration would ever run against a real database,
-- so this new unique index cannot fail to apply against genuinely live
-- data. If a future environment DID somehow have two simultaneously-open
-- (instrument_id, reason) rows already on file, this migration's CREATE
-- UNIQUE INDEX would fail loudly (not silently corrupt data) -- the correct,
-- safe failure mode for a uniqueness-tightening migration.
-- ===========================================================================

create unique index if not exists idx_ii_nav_retention_holds_one_open_per_reason
  on ii_nav_retention_holds(instrument_id, reason)
  where released_at is null;
comment on index idx_ii_nav_retention_holds_one_open_per_reason is
  'NAV 1 R3. At most one OPEN (released_at is null) hold per (instrument_id, reason) at a time. A
  genuinely new certification lifecycle after a prior hold is released is NOT blocked by this index --
  released_at is null is exactly the "still the same open lineage" test. See migration 0171 header.';

create or replace function pc6_hold_instrument_on_statement_acceptance() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('certified', 'certified_with_warnings')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    insert into ii_nav_retention_holds (instrument_id, reason, expires_at)
    values (
      new.instrument_id,
      'statement_reconciliation_in_progress',
      now() + interval '30 days'
    )
    on conflict (instrument_id, reason) where released_at is null
    do update set
      -- Extend, never shrink: a re-certification while the SAME hold is
      -- still open refreshes the protection window rather than creating a
      -- sibling row that says the identical thing. GREATEST guards against
      -- ever moving expires_at backward if this were ever invoked with a
      -- shorter interval in the future.
      expires_at = greatest(ii_nav_retention_holds.expires_at, excluded.expires_at);
  end if;
  return new;
end;
$$;
comment on function pc6_hold_instrument_on_statement_acceptance is
  'NAV 1.25/1.39, idempotency per NAV 1 R3 (migration 0171). Fires on ii_portfolio_truth_status
  certifying a statement; creates a bounded (30-day) ii_nav_retention_holds row, or -- if one is
  already open for this exact (instrument_id, reason) -- extends its expiry instead of duplicating
  it. Never fetches, never writes NAV data, never fires on a non-certifying status. A genuinely new
  certification lifecycle after the prior hold is released still gets its own new, independent row.';

-- The trigger itself (installed by 0168) is unchanged -- only the function
-- body changes, which the existing `after insert or update` trigger picks
-- up automatically. Re-stating it here is redundant but kept for a reader
-- who inspects 0171 without also having 0168 open.
drop trigger if exists trg_pc6_hold_on_statement_acceptance on ii_portfolio_truth_status;
create trigger trg_pc6_hold_on_statement_acceptance
  after insert or update on ii_portfolio_truth_status
  for each row execute function pc6_hold_instrument_on_statement_acceptance();

-- ===========================================================================
-- PART B -- a genuine, previously-undetected correctness bug found while
-- reviewing this same function/table pair for R1 (report pinning).
--
-- pc6_nav_row_is_candidate() (migration 0166) documents, in its own header
-- comment, that "pinned_by_report_or_revision(row) has NO real binding yet
-- ... this function therefore fails CLOSED for that predicate". The ACTUAL
-- SQL, however, wrote that predicate as the literal `or false` -- which
-- contributes NOTHING to the OR chain inside `not(...)`, i.e. it fails
-- OPEN, the exact opposite of its own documented contract, and the exact
-- opposite of navRetentionPolicy.ts's real implementation
-- (pinnedByReportOrRevision(): "if (!ctx.reportPinLookup) return true;" --
-- true means PROTECT). The two implementations that this migration's own
-- comment warns "must be kept in sync deliberately" had silently diverged
-- since 0166 first shipped.
--
-- IMPACT, stated precisely: in DEV today this has caused no observable harm
-- YET, because DEV's report-pinning dependency is also unbuilt on the TS
-- side and no cleanup DELETE has ever run against real data (NAV 1.43 is
-- explicitly unexecuted). But NAV 1.42's own dry-run manifest, and any
-- future NAV 1.43 deletion, that relies on this RPC (rather than only the
-- TS engine) would have silently treated every report-pinned row as a safe
-- deletion candidate the moment real reports and real cleanup candidates
-- ever coexisted -- a genuine, serious latent defect in a function whose
-- entire purpose is deletion-safety.
--
-- FIX (interim, matching the TS engine's OWN interim default exactly):
-- `or true` -- fail closed for real, until migration 0172 (R1 report
-- pinning) replaces this placeholder with a real EXISTS check against the
-- new report-pin manifest it introduces. This makes EVERY row report-pinned
-- (maximally conservative) until 0172 narrows it -- correct and safe, if
-- temporarily overbroad, exactly mirroring the TS engine's own documented
-- "no wired lookup means protect" stance rather than silently disagreeing
-- with it.
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
    or true -- pinned_by_report_or_revision: FIXED in 0171 to genuinely fail closed (was `or false`,
            -- a real bug -- see PART B header above). Narrowed to a real check in migration 0172.
    or exists (
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
  );
$$;
comment on function pc6_nav_row_is_candidate is
  'NAV 1.07/1.12/1.42 policy contract, bound to real schema. SELECT-only; performs no writes. FIXED in
  migration 0171: pinned_by_report_or_revision now genuinely fails closed (or true), matching its own
  documented contract and navRetentionPolicy.ts -- previously `or false`, a real defect (see 0171 PART
  B). Every row is currently report-pin-protected until migration 0172 narrows this to a real check.';
