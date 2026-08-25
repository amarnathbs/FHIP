-- Investment Intelligence R11 — completion of migration 0082 on DEV.
--
-- LIVE-DEV FINDING, CORRECTED (R11-FINAL closure round, 2026-08-25): an
-- initial schema probe against DEV (vqycarelcoijzwlpkpcz) suggested 0082
-- was PARTIALLY applied (its two ALTER TABLE ... CHECK constraint updates
-- looked live, only the `ii_source_precedence_policy` table/columns tail
-- looked missing). That initial read was WRONG — it relied on a SELECT
-- query with an `.eq('status', 'review_required')` filter as if it proved
-- the CHECK constraint accepted that value; a SELECT filter is valid SQL
-- regardless of what a CHECK constraint permits, so it can never actually
-- test a CHECK constraint. A real INSERT-based probe (this round, direct
-- live test) found the truth: NEITHER of 0082's two ALTER TABLE ... CHECK
-- constraint statements are live on DEV (`insert ... status =
-- 'review_required'` and `insert ... discrepancy_type =
-- 'cross_source_conflict'` both genuinely fail with 23514 constraint
-- violations against real DEV Postgres, reproduced twice). Migration 0082
-- is, in effect, 0% applied — the base tables it references
-- (`ii_transactions`, `ii_reconciliation_cases`, `ii_transaction_source_
-- links`) exist only because they predate R11 (migrations 0033/0035/0040),
-- not because of anything 0082 itself added.
--
-- Per this task's own standing instruction ("Once Live, Freeze Them"), and
-- because even the sliver that might already be live must never be
-- assumed, 0082 itself is left untouched and this migration is written as
-- a COMPLETE, fully idempotent replay of every one of 0082's statements —
-- byte-identical in effect, verified by direct comparison against 0082's
-- own lines 1-103 — safe to run whether 0082 is 0% or partially applied.
--
-- Application status: NOT YET APPLIED to DEV as of this migration's
-- authorship — this sandbox has no DDL-execution mechanism (no `exec_sql`-
-- style RPC exists on this project, no Supabase Management API access
-- token, no direct Postgres connection string — the same standing wall
-- this project's history has hit since R1). See the final closure report
-- for the exact required Product Owner action, and for the DOWNSTREAM
-- consequence this gap has on live-DEV provenance-link/reconciliation-case
-- writes for the cross-source dedup path (the CORE dedup invariant — no
-- duplicate canonical transaction/holding row — is unaffected: it is
-- enforced by the application code's `continue` short-circuit, not by
-- these constraints, and was independently verified live regardless).

-- ---------------------------------------------------------------------------
-- ii_transactions.status — add 'review_required' (0082 lines 34-36).
-- ---------------------------------------------------------------------------
alter table ii_transactions drop constraint if exists ii_transactions_status_check;
alter table ii_transactions add constraint ii_transactions_status_check
  check (status in ('parsed', 'reconciled', 'corrected', 'reversed', 'review_required'));

-- ---------------------------------------------------------------------------
-- ii_reconciliation_cases.discrepancy_type — add the cross-source
-- determinations (0082 lines 46-58).
-- ---------------------------------------------------------------------------
alter table ii_reconciliation_cases drop constraint if exists ii_reconciliation_cases_discrepancy_type_check;
alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in (
  'owner_unmatched', 'account_unmatched', 'instrument_unmatched', 'ambiguous_instrument',
  'transaction_unclassified', 'unit_mismatch', 'value_mismatch', 'duplicate_suspected',
  'missing_opening_history', 'unsupported_document', 'document_corrupt',
  'document_password_required', 'parse_incomplete', 'statement_period_gap', 'other',
  'cross_source_exact_duplicate', 'cross_source_high_confidence_duplicate',
  'cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict'
));

comment on column ii_reconciliation_cases.resolution_method is 'e.g. ''user_mapped_instrument'' | ''admin_override'' | ''accepted_anomaly'' | ''auto_resolved_on_reparse'' | ''auto_resolved_cross_source_precedence'' (R11) — the last one only ever written by resolved_by_actor_type=''system''.';

-- ---------------------------------------------------------------------------
-- ii_source_precedence_policy — versioned, frozen precedence policy
-- (0082 lines 60-93).
-- ---------------------------------------------------------------------------
create table if not exists ii_source_precedence_policy (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null unique,
  is_active boolean not null default false,
  precedence_rules jsonb not null,
  rationale text not null,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'uidx_ii_source_precedence_policy_active'
  ) then
    create unique index uidx_ii_source_precedence_policy_active on ii_source_precedence_policy(is_active) where is_active = true;
  end if;
end $$;

alter table ii_source_precedence_policy enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ii_source_precedence_policy' and policyname = 'read ii_source_precedence_policy'
  ) then
    create policy "read ii_source_precedence_policy" on ii_source_precedence_policy for select using (true);
  end if;
end $$;

insert into ii_source_precedence_policy (policy_version, is_active, precedence_rules, rationale)
select
  'r11-v1',
  true,
  '[
    {"source_key": "cams", "rank": 1},
    {"source_key": "kfintech", "rank": 1},
    {"source_key": "manual", "rank": 2}
  ]'::jsonb,
  'CAMS and KFintech are both AMFI-registered RTA statement providers, both R2-certified parsers covering the same regulated universe — precedence-EQUAL, tie-broken by statement as_of-date freshness (R11_SOURCE_PRECEDENCE_POLICY.md), never by import order. Manual import is the lowest-precedence source: it never overrides RTA-sourced evidence, it only fills gaps RTA evidence does not cover. NSDL/CDSL/broker/MFCentral are not ranked — no parser exists for them in R11 (R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md); a future release adds a rank when it adds the parser.'
where not exists (select 1 from ii_source_precedence_policy where policy_version = 'r11-v1');

-- ---------------------------------------------------------------------------
-- ii_transaction_source_links.match_basis / .reconciliation_case_id
-- (0082 lines 95-103).
-- ---------------------------------------------------------------------------
alter table ii_transaction_source_links add column if not exists match_basis text;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'ii_transaction_source_links_match_basis_check'
  ) then
    alter table ii_transaction_source_links add constraint ii_transaction_source_links_match_basis_check
      check (match_basis is null or match_basis in ('same_fingerprint', 'cross_source_exact', 'cross_source_high_confidence'));
  end if;
end $$;

alter table ii_transaction_source_links add column if not exists reconciliation_case_id uuid references ii_reconciliation_cases(id);
