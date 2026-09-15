-- =============================================================================
-- 0157 — PC7 (M7): Underlying Fund Holdings look-through foundation
-- =============================================================================
--
-- SCOPE NOTE (recorded here because it matters when this file is read later).
-- The M0 master scope ledger (docs/investment-intelligence/
-- II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md §3.4) establishes that NO
-- original approved PC7 scope exists anywhere in this repository. PC7's scope
-- for this mission is Part O of the mission dispatch — O.1 through O.10 — and
-- nothing else. This migration implements the data-foundation half of it.
--
-- MIGRATION NUMBER. 0157 was chosen after re-verifying four sources on
-- 2026-09-15 (scripts/m7_pc7_migration_freshness_probe.mjs):
--   * this branch's migrations folder      -> max 0155
--   * every git ref's migrations folder    -> max 0156, claimed by the separate
--                                             fix/app-review-findings-2026-09-15
--                                             branch (NOT part of this mission)
--   * DEV schema_migrations ledger         -> unreadable (HTTP 406)
--   * PRODUCTION schema_migrations ledger  -> unreadable (HTTP 406)
-- 0156 is therefore taken even though it is not in this lineage, and 0157 is
-- the next genuinely free number.
--
-- DEPENDENCY. This migration REQUIRES 0155 (PC6) to have been applied first:
-- it extends 0155's batch ledger and references 0155's ii_scheme_master. As of
-- 2026-09-15 neither 0155 nor 0157 is applied on DEV or production (0/6 PC6
-- objects present on both, re-probed the same day). Apply in order.
--
-- WHAT ALREADY EXISTED, and why this migration is an EXTENSION not a creation.
-- Migration 0044 (R5) already created ii_fund_holdings_snapshots and
-- ii_fund_holdings_lines with a rich, well-designed shape, and the certified
-- R5 X-Ray engine already reads them. PC7 does not rebuild that. The much
-- shallower ii_fund_holdings table from 0031 (R1) is NOT the look-through
-- shape: it carries only (fund, underlying, date, weight) with no asset type,
-- no sector, no market-cap class, no debt metadata, no quantity, no market
-- value, no versioning and no coverage — it cannot express O.4 at all, and it
-- is left alone rather than extended.
--
-- WHAT THIS MIGRATION ADDS:
--   1. 'fund_holdings_disclosure' as a batch_kind on PC6's ledger (reuse, O.3)
--   2. look-through tables as valid correction targets
--   3. O.4 snapshot fields 0044 lacks: scheme-master link, batch lineage, AMC,
--      immutable source evidence (url/sha256/bytes), value unit, currency,
--      disclosure period, content checksum, resolved-weight coverage
--   4. O.4 line fields 0044 lacks: verbatim industry/rating, source row index,
--      record checksum, yield, sub-section
--   5. the O.7 net-worth-safety assertion, AS A DATABASE FUNCTION
--   6. the PC7 admin capability and its RLS predicate (O.9)
--   7. a DISABLED job-control row (binding override: no autonomous activation)
--
-- O.7 / D.2 — THE DEFINING BOUNDARY, restated in the schema itself.
-- Look-through constituents are analytical decomposition ONLY. A user's fund
-- position is counted once, via its own register value. Nothing in this
-- migration is ever read back into assets / investments / retirement_accounts
-- / liabilities / business_entities / financial_snapshots, and section 5 below
-- makes that assertion RUNNABLE rather than merely asserted in a comment.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PC6 batch ledger: admit PC7's batch kind (O.3 — reuse, not a second stack)
-- ---------------------------------------------------------------------------
alter table ii_reference_import_batches drop constraint if exists ii_reference_import_batches_batch_kind_check;
alter table ii_reference_import_batches
  add constraint ii_reference_import_batches_batch_kind_check
  check (batch_kind in (
    'scheme_master',
    'daily_nav',
    'nav_history',
    'benchmark_level',
    'risk_free_rate',
    -- PC7 (O.3). One batch == one scheme's portfolio disclosure for one
    -- as-of date. PC7 settles ALL-OR-NOTHING rather than PC6's chunk-commit:
    -- a half-written snapshot is not a smaller portfolio, it is a wrong one,
    -- whose coverage would read as a genuine partial disclosure.
    'fund_holdings_disclosure'
  ));

-- Layout identity per batch, so a publisher's silent column rename is
-- DETECTABLE (O.9 "source changes"). A successful import under a changed
-- layout is more dangerous than a failed one, because nobody looks at it.
alter table ii_reference_import_batches add column if not exists source_column_signature text;
alter table ii_reference_import_batches add column if not exists source_sections_seen text[];
comment on column ii_reference_import_batches.source_column_signature is
  'PC7/O.9: the ordered header labels of the source file, joined. A change between consecutive batches of the same source is reported as COLUMN_LAYOUT_CHANGED even when both imports succeeded.';
comment on column ii_reference_import_batches.source_sections_seen is
  'PC7/O.9: section headers observed verbatim in the source file. A section appearing or vanishing is a source change worth an operator''s attention.';

-- ---------------------------------------------------------------------------
-- 1b. ii_sources rows for PC7's disclosure sources (O.4 "source", O.8)
-- ---------------------------------------------------------------------------
-- ii_fund_holdings_snapshots.source_id references ii_sources, so a snapshot
-- cannot be ATTRIBUTED unless the source row exists. Without these rows every
-- PC7 snapshot would be written with source_id NULL and would surface on the
-- X-Ray as 'unattributed' — which is exactly the O.8 failure PC7 is fixing.
--
-- Shipped is_active = FALSE. The rows exist so provenance is expressible and
-- the gap is visible on the admin surface; they are not active because the
-- licensing question (PO-PC7-1 / PO-PC7-2) is genuinely open. 0155's
-- 'reference_data_provider' category is reused rather than inventing a sixth.
insert into ii_sources (source_key, source_label, source_category, country_code, is_active, parser_available, metadata)
select 'amc_portfolio_disclosure',
       'AMC monthly/fortnightly portfolio disclosure (SEBI Master Circular ch.5 cl.5.1.1)',
       'reference_data_provider', 'IN', false, true,
       jsonb_build_object(
         'pc7_blocker', 'PO-PC7-1',
         'reason', 'The SEBI disclosure obligation binds the PUBLISHER; it is not a redistribution licence for a consumer. Per-AMC terms govern and are inconsistent across ~57 AMCs.',
         'parser', 'pc7-sebi-portfolio-parser-v1')
where not exists (select 1 from ii_sources where source_key = 'amc_portfolio_disclosure');

insert into ii_sources (source_key, source_label, source_category, country_code, is_active, parser_available, metadata)
select 'vendor_portfolio_data',
       'Commercial vendor — Indian MF portfolio constituents (no vendor selected)',
       'reference_data_provider', 'IN', false, false,
       jsonb_build_object(
         'pc7_blocker', 'PO-PC7-2',
         'reason', 'Aggregated constituent data is a paid product. No vendor is configured, because configuring one would imply a commercial relationship that does not exist.')
where not exists (select 1 from ii_sources where source_key = 'vendor_portfolio_data');

-- ---------------------------------------------------------------------------
-- 2. Corrections may target look-through data
-- ---------------------------------------------------------------------------
alter table ii_reference_corrections drop constraint if exists ii_reference_corrections_target_table_check;
alter table ii_reference_corrections
  add constraint ii_reference_corrections_target_table_check
  check (target_table in (
    'ii_prices_nav',
    'ii_benchmark_series',
    'ii_risk_free_rates',
    'ii_scheme_master',
    'ii_instrument_benchmarks',
    'ii_fund_holdings_snapshots',
    'ii_fund_holdings_lines'
  ));

-- ---------------------------------------------------------------------------
-- 3. ii_fund_holdings_snapshots — the O.4 fields 0044 does not carry
-- ---------------------------------------------------------------------------

-- O.5: scheme identity comes from the authoritative masters, and PC7 creates
-- none of its own. fund_instrument_id (0044) already points at ii_instruments;
-- this adds the PC6 scheme-level identity alongside it. NULLABLE on purpose —
-- a snapshot whose scheme-master row has not been ingested is still a valid
-- snapshot, and forcing the link would make PC7 unusable until PC6 completes.
alter table ii_fund_holdings_snapshots add column if not exists scheme_master_id uuid references ii_scheme_master(id);
create index if not exists idx_ii_fund_holdings_snapshots_scheme_master
  on ii_fund_holdings_snapshots(scheme_master_id) where scheme_master_id is not null;
comment on column ii_fund_holdings_snapshots.scheme_master_id is
  'PC7/O.5: link to PC6''s effective-dated scheme master. Nullable — an unlinked snapshot is an honest mapping gap surfaced on the PC7 admin surface, never a reason to invent a scheme identity inside X-Ray.';

-- Lineage: which import produced this snapshot.
alter table ii_fund_holdings_snapshots add column if not exists batch_id uuid references ii_reference_import_batches(id);
create index if not exists idx_ii_fund_holdings_snapshots_batch
  on ii_fund_holdings_snapshots(batch_id) where batch_id is not null;

-- O.6 AMC exposure needs the fund house on the snapshot, because the AMC that
-- published a disclosure is a property of that disclosure. Denormalised
-- deliberately: resolving it through the instrument master at read time would
-- silently rewrite history after a fund-house merger.
alter table ii_fund_holdings_snapshots add column if not exists amc_name text;

-- D.3 immutable source evidence. The bytes that produced this snapshot are
-- identified forever, so a disputed number can be traced to a file.
alter table ii_fund_holdings_snapshots add column if not exists source_url text;
alter table ii_fund_holdings_snapshots add column if not exists source_sha256 text;
alter table ii_fund_holdings_snapshots add column if not exists source_byte_length bigint;
alter table ii_fund_holdings_snapshots add column if not exists source_retrieved_at timestamptz;
alter table ii_fund_holdings_snapshots drop constraint if exists ii_fund_holdings_snapshots_sha256_shape;
alter table ii_fund_holdings_snapshots
  add constraint ii_fund_holdings_snapshots_sha256_shape
  check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$') not valid;

-- The reporting period the file covers, e.g. '2026-08'. Distinct from
-- holdings_as_of_date: a monthly disclosure for August has an as-of date of
-- 31 August, but an operator looks for "the August file".
alter table ii_fund_holdings_snapshots add column if not exists disclosure_period text;
alter table ii_fund_holdings_snapshots drop constraint if exists ii_fund_holdings_snapshots_period_shape;
alter table ii_fund_holdings_snapshots
  add constraint ii_fund_holdings_snapshots_period_shape
  check (disclosure_period is null or disclosure_period ~ '^[0-9]{4}-[0-9]{2}$') not valid;

-- THE UNIT TRAP. SEBI-layout files state market value in Rs LAKHS, not rupees.
-- A pipeline that forgets this is out by a factor of 100,000, and the numbers
-- still look like plausible money. The unit is therefore stored WITH the
-- values rather than assumed by the reader.
alter table ii_fund_holdings_snapshots add column if not exists market_value_unit text
  check (market_value_unit is null or market_value_unit in ('units', 'thousands', 'lakhs', 'millions', 'crores'));
alter table ii_fund_holdings_snapshots add column if not exists currency_code char(3);
comment on column ii_fund_holdings_snapshots.market_value_unit is
  'PC7/O.4: the unit the file''s market-value column is denominated in. Indian SEBI-layout disclosures use lakhs. Stored, never assumed — an unstated unit is a 100,000x error that still looks like money.';

-- Content identity, for content-idempotent re-import (O.3).
alter table ii_fund_holdings_snapshots add column if not exists content_checksum text;
alter table ii_fund_holdings_snapshots drop constraint if exists ii_fund_holdings_snapshots_content_checksum_shape;
alter table ii_fund_holdings_snapshots
  add constraint ii_fund_holdings_snapshots_content_checksum_shape
  check (content_checksum is null or content_checksum ~ '^[0-9a-f]{64}$') not valid;

-- O.4 "coverage percentage". 0044 records disclosed_weight_total_pct (what the
-- publisher disclosed); this records how much of it RESOLVED to a canonical
-- security. The two are genuinely different coverage questions and conflating
-- them hides unresolved exposure behind a healthy-looking disclosure total.
alter table ii_fund_holdings_snapshots add column if not exists resolved_weight_total_pct numeric(9, 4);
alter table ii_fund_holdings_snapshots add column if not exists line_count integer;
comment on column ii_fund_holdings_snapshots.resolved_weight_total_pct is
  'PC7/O.4: the share of the fund that resolved to a canonical security. disclosed_weight_total_pct minus this is exposure we can see but cannot name — retained and displayed, never dropped and never rescaled away.';

-- ---------------------------------------------------------------------------
-- 4. ii_fund_holdings_lines — the O.4 fields 0044 does not carry
-- ---------------------------------------------------------------------------

-- The publisher's Industry (equity) or Rating (debt) column, VERBATIM, kept
-- separate from the normalised credit_rating_band that 0044 already has. The
-- normalisation is an interpretation; the raw string is the evidence, and a
-- band that later turns out to be mapped wrong can be re-derived from it.
alter table ii_fund_holdings_lines add column if not exists industry_or_rating_raw text;
alter table ii_fund_holdings_lines add column if not exists sub_section_raw text;
alter table ii_fund_holdings_lines add column if not exists source_row_index integer;
alter table ii_fund_holdings_lines add column if not exists record_checksum text;
alter table ii_fund_holdings_lines add column if not exists yield_pct numeric(9, 4);
alter table ii_fund_holdings_lines drop constraint if exists ii_fund_holdings_lines_record_checksum_shape;
alter table ii_fund_holdings_lines
  add constraint ii_fund_holdings_lines_record_checksum_shape
  check (record_checksum is null or record_checksum ~ '^[0-9a-f]{64}$') not valid;

-- O.9 "unmapped securities" is a partial-index question: the operator only
-- ever wants the unresolved ones, and on a full look-through corpus that is a
-- small minority of a very large table.
create index if not exists idx_ii_fund_holdings_lines_unresolved
  on ii_fund_holdings_lines(snapshot_id) where underlying_instrument_id is null;
create index if not exists idx_ii_fund_holdings_lines_isin
  on ii_fund_holdings_lines(isin) where isin is not null;

comment on column ii_fund_holdings_lines.industry_or_rating_raw is
  'PC7/O.4: the publisher''s Industry/Rating cell exactly as printed. The evidence behind credit_rating_band, kept so a mis-mapped band is correctable without re-fetching the file.';

-- ---------------------------------------------------------------------------
-- 5. O.7 / D.2 — THE NET-WORTH SAFETY ASSERTION, AS A RUNNABLE FUNCTION
-- ---------------------------------------------------------------------------
-- A comment saying "this never affects net worth" is not evidence. This
-- function makes the claim CHECKABLE by the database itself, and it is called
-- by the PC7 test pack, by the PGlite certification and by the live-DEV proof.
--
-- It looks for the two structural ways look-through data could leak into the
-- financial register:
--   (a) a FOREIGN KEY from a net-worth input table to a look-through table,
--       which would mean a register row is defined in terms of look-through
--       data;
--   (b) a tenancy column (user_id / household_id) on a look-through table,
--       which is the shape a table acquires just before someone starts
--       treating it as user-owned wealth.
--
-- It returns ROWS, not a boolean: a violation must arrive with its own
-- description, so a failure says what is wrong rather than merely that
-- something is.
create or replace function ii_pc7_networth_safety_violations()
returns table (violation_code text, object_name text, detail text)
language sql
stable
security invoker
set search_path = public
as $$
  -- (a) FK from a register table into look-through data
  select
    'LOOKTHROUGH_FK_FROM_REGISTER'::text,
    (src.relname || '.' || con.conname)::text,
    format(
      'Table %s has a foreign key (%s) referencing look-through table %s. A net-worth input defined in terms of look-through data would let an analytical decomposition contribute a SECOND time to household wealth.',
      src.relname, con.conname, tgt.relname
    )::text
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_class tgt on tgt.oid = con.confrelid
  where con.contype = 'f'
    and src.relname in ('assets', 'investments', 'retirement_accounts', 'liabilities', 'business_entities', 'financial_snapshots')
    and tgt.relname in ('ii_fund_holdings', 'ii_fund_holdings_snapshots', 'ii_fund_holdings_lines')

  union all

  -- (b) tenancy column on a look-through table
  select
    'LOOKTHROUGH_HAS_TENANCY_COLUMN'::text,
    (c.relname || '.' || a.attname)::text,
    format(
      'Look-through table %s carries a tenancy column (%s). Look-through data is GLOBAL reference data about a scheme, identical for every user who holds it. A per-user column is the shape this data takes just before it starts being treated as user-owned wealth.',
      c.relname, a.attname
    )::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relname in ('ii_fund_holdings', 'ii_fund_holdings_snapshots', 'ii_fund_holdings_lines')
    and a.attnum > 0
    and not a.attisdropped
    and a.attname in ('user_id', 'household_id', 'owner_user_id', 'profile_id');
$$;

comment on function ii_pc7_networth_safety_violations() is
  'PC7/O.7 and global D.2. Returns one row per structural way look-through data could contribute a second net-worth entry. An EMPTY result is the passing state. Called by the PC7 test pack, the PGlite certification and the live-DEV safety proof — the invariant is asserted by the database, not only in comments.';

-- ---------------------------------------------------------------------------
-- 6. O.9 — the PC7 admin capability
-- ---------------------------------------------------------------------------
-- Admin Architecture Standard §2: a new admin surface gets its own NAMED
-- capability and may not ride on a coarse admin flag. PC6's
-- can_view_reference_data_quality is itself a named capability, but it
-- authorises a different surface (NAV/benchmark/risk-free feeds). Look-through
-- quality is separately grantable: an operator may legitimately be trusted
-- with fund-portfolio data quality without being given the market-data feeds,
-- and vice versa.
alter table admin_users add column if not exists can_view_lookthrough_data_quality boolean not null default false;
comment on column admin_users.can_view_lookthrough_data_quality is
  'PC7/O.9: a separately-named, separately-tested capability (Admin Architecture Standard §2) authorising the read-only Underlying Fund Holdings quality surface. Deliberately NOT implied by presence in admin_users, and NOT implied by can_view_reference_data_quality.';

create or replace function is_pc7_lookthrough_data_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admin_users
    where admin_users.user_id = auth.uid()
      and admin_users.can_view_lookthrough_data_quality = true
  );
$$;
comment on function is_pc7_lookthrough_data_admin() is
  'PC7/O.9. True only for an admin_users row with can_view_lookthrough_data_quality=true. Backs RLS at the database layer (Admin Standard §4: navigation is not authorisation).';

-- ---------------------------------------------------------------------------
-- 7. Job control — SHIPPED DISABLED
-- ---------------------------------------------------------------------------
-- The binding execution override for this mission forbids an autonomous agent
-- activating a real ingestion schedule. Independently, every PC7 disclosure
-- source is itself disabled pending a Product Owner licensing decision
-- (PO-PC7-1 / PO-PC7-2). The row exists so the kill switch is visible and
-- auditable; enabling it is a deliberate operator act.
--
-- decideStart() in the runner FAILS CLOSED on a missing row, so shipping this
-- row disabled is strictly more informative than omitting it: the operator
-- surface can show a job that exists and is switched off, rather than nothing.
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc7_fund_holdings_disclosure', false,
  'Shipped disabled by migration 0157. Two independent reasons: (1) every PC7 disclosure source awaits a Product Owner licensing decision (PO-PC7-1 AMC terms, PO-PC7-2 commercial vendor); (2) this mission''s binding override forbids an autonomous agent activating a production ingestion schedule. Enable only with a human present and a named approved source.'
where not exists (select 1 from ii_reference_job_control where job_key = 'pc7_fund_holdings_disclosure');

-- ---------------------------------------------------------------------------
-- 8. Table-level restatement of the boundary
-- ---------------------------------------------------------------------------
comment on table ii_fund_holdings_snapshots is
  'Versioned Underlying Fund Holdings snapshot headers (R5 0044, extended by PC7 0157). Shared GLOBAL reference data: world-readable, write-restricted to trusted server/admin processes, no tenancy column. Snapshots are preserved, never overwritten. O.7/D.2: these rows are ANALYTICAL DECOMPOSITION of a fund position that is already counted once in the investment register — they never create a second net-worth contribution. ii_pc7_networth_safety_violations() asserts that structurally.';
comment on table ii_fund_holdings_lines is
  'Per-constituent Underlying Fund Holding detail (R5 0044, extended by PC7 0157). underlying_instrument_id is nullable ON PURPOSE: an unresolvable line stays UNRESOLVED and is retained as explicit unresolved exposure — never name-matched into a lookalike security, never silently dropped. O.7/D.2 applies exactly as to the snapshot header.';
