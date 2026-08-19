-- Investment Intelligence R2 — Migration B: transaction/holding-snapshot
-- parser-lineage columns, deterministic transaction-fingerprint
-- deduplication, and the multi-source lineage table for DEDUP-003
-- (the same real-world transaction observed in more than one statement
-- must resolve to ONE canonical row, with every corroborating document
-- recorded, never duplicated and never silently discarded).
--
-- Additive only. ii_transactions/ii_holding_snapshots remain immutable —
-- every new column here is nullable (R1 rows have no value; that is
-- correct, not a gap, since R1 never ran a real parser) or has a safe
-- default. No existing row can violate any new constraint.
--
-- Governing docs: R2_TRANSACTION_NORMALISATION.md, spec sections 9, 20, 21, 22.

-- ---------------------------------------------------------------------------
-- ii_transactions.transaction_type — extend the R1-frozen 12-value
-- taxonomy (migration 0033) with the additional canonical values spec
-- section 19 requires that R1's manual-importer-only taxonomy did not yet
-- need: distinct STP in/out, SWP, distinct transfer in/out, REVERSAL,
-- SEGREGATION, and the explicit UNCLASSIFIED catch-all ("do not force an
-- unknown transaction description into an incorrect type"). 'transfer' and
-- 'adjustment' (R1 values) are KEPT, not removed — 'transfer' remains valid
-- for a genuinely undirected/legacy transfer record, 'adjustment' remains
-- the generic non-transactional correction type distinct from a
-- classification failure (UNCLASSIFIED).
-- ---------------------------------------------------------------------------
alter table ii_transactions drop constraint ii_transactions_transaction_type_check;
alter table ii_transactions add constraint ii_transactions_transaction_type_check check (transaction_type in (
  'purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment',
  'transfer', 'merger', 'fee', 'tax', 'adjustment',
  'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out', 'reversal', 'segregation', 'unclassified'
));

-- ---------------------------------------------------------------------------
-- ii_transactions — parser lineage + fingerprint dedup.
-- ---------------------------------------------------------------------------
alter table ii_transactions add column parse_run_id uuid references ii_document_parse_runs(id);
alter table ii_transactions add column parser_code text;
alter table ii_transactions add column parser_version_used text; -- denormalised copy of the run's parser_version, for fast lineage queries without a join
alter table ii_transactions add column source_description text; -- raw narrative line from the statement, verbatim (never fabricated)
alter table ii_transactions add column fees numeric(18, 2); -- explicit only — never inferred/estimated (spec section 20)
alter table ii_transactions add column taxes numeric(18, 2); -- raw field only — R2 never CALCULATES tax consequences (spec section 20, performance firewall)
alter table ii_transactions add column confidence numeric(5, 4) check (confidence is null or (confidence >= 0 and confidence <= 1));
-- Deterministic dedup fingerprint (spec section 21) — sha256 hex computed
-- application-side (lib/services/investment-intelligence/fingerprint.ts) over
-- {source_key, account_id, instrument_id, transaction_date, transaction_type,
-- exact gross_amount, exact units, exact price_per_unit, source_reference}.
-- Never null for a parser-created row; nullable only because R1's manual
-- importer and any future manual-entry path may legitimately have none.
alter table ii_transactions add column transaction_fingerprint text;

comment on column ii_transactions.transaction_fingerprint is 'Deterministic SHA-256 dedup fingerprint (R2_TRANSACTION_NORMALISATION.md). NOT a substitute for source_reference-based idempotency (uidx_ii_transactions_dedup, migration 0033) — this is the SECOND, source-reference-independent dedup layer for statements/RTAs that provide no stable per-line reference.';

-- The core CRITICAL-FAILURE-CONDITION guard: no two ii_transactions rows for
-- the SAME account may carry the same fingerprint. Partial (fingerprint not
-- null) so R1/manual rows with no fingerprint are unaffected.
create unique index uidx_ii_transactions_fingerprint
  on ii_transactions(account_id, transaction_fingerprint)
  where transaction_fingerprint is not null;

create index idx_ii_transactions_parse_run on ii_transactions(parse_run_id) where parse_run_id is not null;

-- ---------------------------------------------------------------------------
-- ii_transaction_source_links — DEDUP-003: when a later statement
-- re-reports a transaction FHIP already holds canonically (same
-- fingerprint), the existing ii_transactions row is NOT duplicated, but the
-- fact that a second document also evidences it must not be silently
-- discarded either (spec sections 22, 45 — "do not silently choose one").
-- This table is the append-only, multi-source lineage record: one row per
-- (canonical transaction, corroborating document) pair.
-- ---------------------------------------------------------------------------
create table ii_transaction_source_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references ii_transactions(id) on delete cascade,
  source_document_id uuid not null references ii_source_documents(id) on delete cascade,
  parse_run_id uuid references ii_document_parse_runs(id),
  observed_at timestamptz not null default now(),
  is_originating boolean not null default false, -- true for exactly the one link that created the canonical row
  unique (transaction_id, source_document_id)
);
create index idx_ii_transaction_source_links_user on ii_transaction_source_links(user_id);
create index idx_ii_transaction_source_links_transaction on ii_transaction_source_links(transaction_id);
create index idx_ii_transaction_source_links_document on ii_transaction_source_links(source_document_id);

alter table ii_transaction_source_links enable row level security;
create policy "own ii_transaction_source_links" on ii_transaction_source_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_holding_snapshots — parser lineage + explicit statement-provided NAV
-- (distinct from price_per_unit on ii_transactions; spec section 23 —
-- "Where the CAS contains ... statement NAV where explicitly provided").
-- history_completeness (spec section 46) is attached here because a
-- holding snapshot IS the point at which a completeness determination is
-- made for that as-of date; ii_portfolio_truth_status (migration 0041)
-- carries the CURRENT/latest determination for the position as a whole.
-- ---------------------------------------------------------------------------
alter table ii_holding_snapshots add column parse_run_id uuid references ii_document_parse_runs(id);
alter table ii_holding_snapshots add column parser_code text;
alter table ii_holding_snapshots add column parser_version_used text;
alter table ii_holding_snapshots add column source_nav numeric(20, 6); -- NAV as explicitly printed on the statement for this as-of date, nullable — never substituted with a fetched/current NAV (spec section 23)
alter table ii_holding_snapshots add column history_completeness text check (history_completeness is null or history_completeness in (
  'complete_from_inception', 'complete_from_known_opening_balance', 'partial_history', 'holdings_only'
));

create index idx_ii_holding_snapshots_parse_run on ii_holding_snapshots(parse_run_id) where parse_run_id is not null;

comment on column ii_holding_snapshots.source_nav is 'NAV exactly as printed on the statement, if present. Distinct from any current/live NAV — R2 never fetches or infers current NAV (spec section 47, performance firewall).';
