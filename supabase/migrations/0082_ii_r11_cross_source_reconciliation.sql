-- Investment Intelligence R11 — Multi-source & Professional Expansion,
-- Objective A: cross-source canonical evidence.
--
-- R11-P0 finding (docs/investment-intelligence/R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md):
-- ii_accounts resolution (accountResolution.ts) is already source-agnostic
-- (keyed on user+institution+normalised folio), and ii_fhip_publications
-- net-worth supersession (investmentPublicationService.ts) is already keyed
-- on (account_id, instrument_id) freshness, not per-source — so those two
-- layers already avoid cross-source duplication. The one real, evidenced
-- gap is at the TRANSACTION layer: fingerprint.ts's dedup fingerprint
-- embeds source_key as its first field by design (correct for same-source
-- re-import idempotency, migration 0040), so a transaction observed via two
-- DIFFERENT sources (CAMS vs KFintech vs manual) never collides today and
-- silently creates two canonical ii_transactions rows for one real-world
-- transaction. This migration adds the minimum additive structure needed
-- to close that gap by REUSING the existing R2 provenance/correction
-- framework (ii_transaction_source_links, ii_reconciliation_cases) rather
-- than building a parallel one, per spec section 41.
--
-- Additive only. No existing row can violate any new/extended constraint:
-- new status/discrepancy_type values are pure additions to existing check
-- constraints (same technique migration 0040 already used), and the new
-- column defaults preserve every existing row's current behaviour exactly.

-- ---------------------------------------------------------------------------
-- ii_transactions.status — add 'review_required' (spec sections 25/32:
-- "REVIEW_REQUIRED... never silently merge" for a cross-source AMBIGUOUS or
-- CONFLICT determination). A transaction in this status is preserved in
-- full (never deleted, never guessed into 'parsed') but excluded from R4/
-- R5/R6 analytical aggregation until a human resolves the linked
-- ii_reconciliation_cases row — identical exclusion mechanism already used
-- for 'reversed' (R4/R5/R6 already filter `status !== 'reversed'`).
-- ---------------------------------------------------------------------------
alter table ii_transactions drop constraint ii_transactions_status_check;
alter table ii_transactions add constraint ii_transactions_status_check
  check (status in ('parsed', 'reconciled', 'corrected', 'reversed', 'review_required'));

-- ---------------------------------------------------------------------------
-- ii_reconciliation_cases.discrepancy_type — add the cross-source
-- determinations (spec sections 25, 32). subject_type already allows
-- 'transaction' and 'holding_snapshot' (migration 0035) — no change needed
-- there. Written into the SAME table R2 already certified, not a new one
-- (spec section 41: "reuse the existing II correction/provenance
-- framework").
-- ---------------------------------------------------------------------------
alter table ii_reconciliation_cases drop constraint ii_reconciliation_cases_discrepancy_type_check;
alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in (
  'owner_unmatched', 'account_unmatched', 'instrument_unmatched', 'ambiguous_instrument',
  'transaction_unclassified', 'unit_mismatch', 'value_mismatch', 'duplicate_suspected',
  'missing_opening_history', 'unsupported_document', 'document_corrupt',
  'document_password_required', 'parse_incomplete', 'statement_period_gap', 'other',
  'cross_source_exact_duplicate', 'cross_source_high_confidence_duplicate',
  'cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict'
));

-- resolution_method already free text; document the new deterministic
-- values R11 writes there for an auto-resolved EXACT/HIGH_CONFIDENCE case:
comment on column ii_reconciliation_cases.resolution_method is 'e.g. ''user_mapped_instrument'' | ''admin_override'' | ''accepted_anomaly'' | ''auto_resolved_on_reparse'' | ''auto_resolved_cross_source_precedence'' (R11) — the last one only ever written by resolved_by_actor_type=''system''.';

-- ---------------------------------------------------------------------------
-- ii_source_precedence_policy — versioned, frozen precedence policy (spec
-- section 30: "define a versioned source-precedence policy... precedence
-- never erases evidence"). World-readable reference data, admin/system
-- write only — identical discipline to ii_reconciliation_config (migration
-- 0041) and ii_sources (migration 0031). Exactly one row has is_active=true.
-- ---------------------------------------------------------------------------
create table ii_source_precedence_policy (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null unique,
  is_active boolean not null default false,
  -- ordered lowest-rank-wins-ties-by-freshness list; a JSON array of
  -- {source_key, rank} — lower rank = higher precedence. Sources with the
  -- SAME rank are precedence-EQUAL and resolved by statement as_of date
  -- freshness (never by import order — R11 import-order-independence
  -- requirement).
  precedence_rules jsonb not null,
  rationale text not null,
  created_at timestamptz not null default now()
);
create unique index uidx_ii_source_precedence_policy_active on ii_source_precedence_policy(is_active) where is_active = true;
alter table ii_source_precedence_policy enable row level security;
create policy "read ii_source_precedence_policy" on ii_source_precedence_policy for select using (true);

insert into ii_source_precedence_policy (policy_version, is_active, precedence_rules, rationale) values (
  'r11-v1',
  true,
  '[
    {"source_key": "cams", "rank": 1},
    {"source_key": "kfintech", "rank": 1},
    {"source_key": "manual", "rank": 2}
  ]'::jsonb,
  'CAMS and KFintech are both AMFI-registered RTA statement providers, both R2-certified parsers covering the same regulated universe — precedence-EQUAL, tie-broken by statement as_of-date freshness (R11_SOURCE_PRECEDENCE_POLICY.md), never by import order. Manual import is the lowest-precedence source: it never overrides RTA-sourced evidence, it only fills gaps RTA evidence does not cover. NSDL/CDSL/broker/MFCentral are not ranked — no parser exists for them in R11 (R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md); a future release adds a rank when it adds the parser.'
);

-- ---------------------------------------------------------------------------
-- ii_transaction_source_links.match_basis — record WHY a corroborating
-- document was linked rather than creating a new canonical row (spec
-- section 32: "explain which records were compared, which fields matched/
-- differed"). Nullable: existing R2 same-fingerprint links (is_originating
-- semantics unchanged) simply have no value here — that path is untouched.
-- ---------------------------------------------------------------------------
alter table ii_transaction_source_links add column match_basis text check (match_basis is null or match_basis in ('same_fingerprint', 'cross_source_exact', 'cross_source_high_confidence'));
alter table ii_transaction_source_links add column reconciliation_case_id uuid references ii_reconciliation_cases(id);
