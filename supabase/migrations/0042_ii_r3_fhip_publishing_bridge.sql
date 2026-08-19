-- Investment Intelligence R3 — Migration A: the real FHIP publishing bridge.
--
-- Additive only. No existing column, constraint, index, or row is removed.
-- Every ALTER on an existing check constraint drops and recreates it with a
-- STRICT SUPERSET of the previously-allowed values (same pattern as R2's
-- migration 0039). The one exception is `uq_investments_user_master`, which
-- is *relaxed* (not removed in spirit) — see section 2 below for the exact
-- reasoning and the backward-compatible replacement.
--
-- Governing docs: R0_FHIP_PUBLISHING_CONTRACT.md, R0_NET_WORTH_DEDUP_CONTRACT.md,
-- R0_CANONICAL_DATA_CONTRACT.md, R0_CROSS_BORDER_CONTRACT.md, ADR-004, ADR-006,
-- R3_PUBLISHING_ARCHITECTURE.md, R3_FHIP_MAPPING_SPEC.md, R3_ARCHITECTURE_EXCEPTION.md.

-- ===========================================================================
-- SECTION 1 — ii_fhip_publications: extend from "structural foundation" (R1)
-- to a real, queryable publication record with economic-position identity,
-- currency/quality/lineage metadata, and a DB-enforced one-active-per-
-- position guarantee.
-- ===========================================================================

-- Economic-position identity, denormalised from ii_holding_snapshots ->
-- ii_accounts / ii_instruments at publish time. This is what makes
-- "one active publication per position" enforceable at the database level
-- (spec section 43/44) — canonical_position_id alone is a per-SNAPSHOT key
-- (a new certified valuation is a new immutable ii_holding_snapshots row,
-- per R0_CANONICAL_DATA_CONTRACT.md), so a refresh naturally produces a
-- fresh canonical_position_id that would NOT collide with
-- unique(canonical_position_id) alone. account_id+instrument_id is the
-- stable identity that spans snapshots/refreshes.
alter table ii_fhip_publications add column account_id uuid references ii_accounts(id);
alter table ii_fhip_publications add column instrument_id uuid references ii_instruments(id);

-- Owner resolution record (R0_FHIP_PUBLISHING_CONTRACT.md OWNER section).
-- owner_member_id is the household_members row Investment Intelligence
-- resolved the position to; published_owner is the actual investments.owner
-- ROLE ENUM value derived from that member's `relationship` and written into
-- the FHIP row (investments.owner is a role enum, NOT a household_members FK
-- — confirmed against migration 0004; R3_FHIP_MAPPING_SPEC.md documents the
-- relationship->owner-enum mapping this corrects from the R0 contract's
-- imprecise "resolved to a household_members.id" phrasing).
alter table ii_fhip_publications add column owner_member_id uuid references household_members(id);
alter table ii_fhip_publications add column published_owner text check (published_owner is null or published_owner in ('self','spouse','joint','child','family_trust','company','smsf','other'));

-- Source currency/country retained on the publication itself (not just
-- reachable via a join) so a publication's own history is self-describing
-- for audit/currency test purposes without re-joining immutable upstream
-- rows (R0_CROSS_BORDER_CONTRACT.md).
alter table ii_fhip_publications add column source_currency char(3) references currencies(currency_code);
alter table ii_fhip_publications add column source_country char(2) references countries(country_code);

-- The exact source-currency value/cost-base/contribution/risk-band this
-- publication event wrote into the target FHIP row — captured here so a
-- later refresh can compute an exact financial-impact delta (spec section
-- 42, NW-003) without re-deriving history from ii_holding_snapshots.
alter table ii_fhip_publications add column published_value numeric(18, 2);
alter table ii_fhip_publications add column published_cost_base numeric(18, 2);
alter table ii_fhip_publications add column cost_base_status text not null default 'unknown' check (cost_base_status in ('certified', 'partial', 'unknown', 'not_available'));
alter table ii_fhip_publications add column published_annual_contribution numeric(18, 2);
alter table ii_fhip_publications add column annual_contribution_source text not null default 'none' check (annual_contribution_source in ('confirmed_user_plan', 'none'));
-- Investment RISK BAND (never the household member's personal risk
-- tolerance — R0_FHIP_PUBLISHING_CONTRACT.md RISK PROFILE section; no such
-- "risk tolerance" concept exists anywhere in FHIP per R0 discovery).
-- 'unknown' is a correct, deliberate value, not a placeholder for a bug.
alter table ii_fhip_publications add column risk_band text not null default 'unknown' check (risk_band in ('conservative', 'balanced', 'growth', 'high_growth', 'unknown'));

alter table ii_fhip_publications add column target_master_item_key text;

-- Base-currency (household reporting currency) figure, DISPLAY-ONLY,
-- recomputed at preview/refresh time using the existing
-- forecast_global_assumptions fx_rate_aud_inr row (lib/services/
-- dashboardData.ts's getFxRateAudInr) — never authoritative, never fed back
-- into investments.current_value, never a substitute for computeDashboard()'s
-- own live conversion. Stored purely so a publication preview / audit trail
-- can show "what this looked like in AUD at the time" without recomputing
-- from a since-changed FX rate (R0_CROSS_BORDER_CONTRACT.md section 3).
alter table ii_fhip_publications add column base_currency_code char(3) references currencies(currency_code);
alter table ii_fhip_publications add column base_currency_amount numeric(18, 2);
alter table ii_fhip_publications add column base_currency_rate_used numeric(18, 6);
alter table ii_fhip_publications add column base_currency_computed_at timestamptz;

comment on column ii_fhip_publications.base_currency_amount is 'DISPLAY-ONLY derived figure for preview/audit. Never written into investments.current_value; computeDashboard() always recomputes the live base-currency figure from the stored source-currency investments row at read time.';

-- Manual/imported linkage record (spec sections 26-28, DD-005).
alter table ii_fhip_publications add column linkage_type text not null default 'new_position' check (linkage_type in ('new_position', 'linked_manual_row'));
alter table ii_fhip_publications add column linked_manual_investment_id uuid;

-- Refresh/supersession lineage (spec sections 33-35). Both directions kept
-- for cheap traversal either way; exactly one of a chain's publications has
-- superseded_by_publication_id null (the currently active or terminal one).
alter table ii_fhip_publications add column supersedes_publication_id uuid references ii_fhip_publications(id);
alter table ii_fhip_publications add column superseded_by_publication_id uuid references ii_fhip_publications(id);
alter table ii_fhip_publications add column supersession_reason text;

-- Idempotency (spec section 45/46) — correlation_id ties every audit event
-- from one publish REQUEST together; idempotency_key is deterministic
-- (account_id + instrument_id + canonical_position_id + target), computed
-- application-side, so a double-click/retry can be recognised and answered
-- from the existing row rather than racing a second insert.
alter table ii_fhip_publications add column correlation_id uuid;
alter table ii_fhip_publications add column idempotency_key text;
alter table ii_fhip_publications add column failure_reason text;
alter table ii_fhip_publications add column created_at timestamptz not null default now();

create index idx_ii_fhip_publications_position on ii_fhip_publications(account_id, instrument_id);
create index idx_ii_fhip_publications_idempotency on ii_fhip_publications(idempotency_key) where idempotency_key is not null;
create index idx_ii_fhip_publications_correlation on ii_fhip_publications(correlation_id) where correlation_id is not null;

-- THE central no-double-count / idempotency DB guarantee for R3: at most one
-- 'published'-status row may exist for a given economic position
-- (account_id, instrument_id) at any time. A refresh/relink/republish must
-- transition the OLD active row to 'superseded'/'unpublished' in the SAME
-- transaction as activating the new one — never leave two 'published' rows
-- for the same position (spec section 25, "no double-counting" section 29,
-- FAIL condition "old+new publications both active in net worth").
create unique index uidx_ii_fhip_publications_one_active_position
  on ii_fhip_publications(account_id, instrument_id)
  where status = 'published';

-- Extend the R1-frozen 3-value status vocabulary with exactly one new
-- terminal state: 'failed' — a publish attempt that could not complete
-- atomically (spec section 46's compensating-state workflow needs a
-- persisted, queryable terminal state distinct from a healthy 'published'
-- row or the simple absence of one). 'published'/'unpublished'/'superseded'
-- are reproduced verbatim, unchanged.
alter table ii_fhip_publications drop constraint ii_fhip_publications_status_check;
alter table ii_fhip_publications add constraint ii_fhip_publications_status_check check (status in ('published', 'unpublished', 'superseded', 'failed'));

-- ===========================================================================
-- SECTION 2 — investments: source markers, publication linkage, and the
-- relaxed uniqueness fix.
--
-- ARCHITECTURE NOTE (see R3_ARCHITECTURE_EXCEPTION.md for the full writeup):
-- `investments` carries `unique(user_id, master_item_key)` (migration 0004),
-- designed for the manual spreadsheet-style grid's "one row per catalogue
-- item, re-checking a box upserts it" behaviour (lib/services/registry.ts's
-- save()). A household holding more than one certified mutual fund position
-- under the same master_item_key='managed_funds' category (the overwhelming
-- common real-world case) would collide with this constraint if Investment
-- Intelligence inserted a second row for a second distinct fund. The fix
-- below is NOT a removal of the manual-entry guarantee — it is narrowed with
-- a partial index so it applies EXACTLY as before to source_type='manual'
-- rows (byte-for-byte the same behaviour every existing manual row already
-- has), while Investment-Intelligence-published rows are governed by their
-- own, stronger identity guarantee instead: the
-- uidx_ii_fhip_publications_one_active_position index above, which prevents
-- the real double-counting risk (two ACTIVE publications for the same
-- economic position) at a finer grain than "one row per category" ever did.
-- ===========================================================================

alter table investments add column source_type text not null default 'manual' check (source_type in ('manual', 'investment_intelligence_published'));
alter table investments add column ii_publication_id uuid references ii_fhip_publications(id);
alter table investments add column ii_canonical_account_id uuid references ii_accounts(id);
alter table investments add column ii_canonical_instrument_id uuid references ii_instruments(id);
-- Pre-link snapshot of a manual row's own values, captured ONCE at the
-- moment a manual row is confirmed as the same economic investment as a
-- certified II position and converted in place (spec section 28 — "do not
-- delete history"). Restored on unpublish (R3's explicit resolution of the
-- R0-flagged open UX item — see R3_DUPLICATE_RESOLUTION_SPEC.md).
alter table investments add column pre_publication_manual_snapshot jsonb;
alter table investments add column ii_linked_at timestamptz;
alter table investments add column ii_last_refreshed_at timestamptz;
alter table investments add column ii_source_quality_status text check (ii_source_quality_status is null or ii_source_quality_status in ('certified', 'warning', 'incomplete'));

create index idx_investments_ii_publication on investments(ii_publication_id) where ii_publication_id is not null;
create index idx_investments_source_type on investments(user_id, source_type);

-- Relax: drop the table-level unique constraint, replace with an equivalent
-- PARTIAL unique index scoped to manual rows only (every existing row is
-- source_type='manual' by the new column's default, so this reproduces the
-- exact prior guarantee for 100% of existing data with zero behaviour
-- change for the manual-entry grid).
alter table investments drop constraint uq_investments_user_master;
create unique index uidx_investments_user_master_manual
  on investments(user_id, master_item_key)
  where source_type = 'manual';

-- ===========================================================================
-- SECTION 3 — assets / retirement_accounts: the SAME structural source
-- markers, so the R0 12-scenario matrix's future-routing scenarios (DD-006
-- NPS->Retirement, DD-007/DD-008 term-deposit/gold routing) can be proven
-- structurally (spec section 51) even though R2 does not yet certify those
-- asset types for production publication. No R3 production write path
-- targets these tables' new columns — they exist so the routing/identity
-- guarantee can be exercised and unit-tested end-to-end for the SAME
-- mechanism a future release will activate, without a schema change then.
-- ===========================================================================

alter table assets add column source_type text not null default 'manual' check (source_type in ('manual', 'investment_intelligence_published'));
alter table assets add column ii_publication_id uuid references ii_fhip_publications(id);
create index idx_assets_ii_publication on assets(ii_publication_id) where ii_publication_id is not null;

alter table retirement_accounts add column source_type text not null default 'manual' check (source_type in ('manual', 'investment_intelligence_published'));
alter table retirement_accounts add column ii_publication_id uuid references ii_fhip_publications(id);
create index idx_retirement_accounts_ii_publication on retirement_accounts(ii_publication_id) where ii_publication_id is not null;

-- ===========================================================================
-- SECTION 4 — ii_audit_events: extend the R1/R2 vocabulary (migrations
-- 0036, 0039) with the R3 publication-lifecycle event types (spec section
-- 47). All prior values reproduced verbatim; nothing removed. R1's
-- 'publication'/'republishing' values are kept (not reused going forward —
-- R3 call sites use the more specific new values below) since old rows
-- using them must remain valid.
-- ===========================================================================
alter table ii_audit_events drop constraint ii_audit_events_event_type_check;
alter table ii_audit_events add constraint ii_audit_events_event_type_check check (event_type in (
  -- R1 (migration 0036)
  'upload', 'parse', 'parse_completed', 'reconciliation_opened', 'reconciliation_resolved',
  'user_correction', 'admin_correction', 'publication', 'republishing', 'nav_price_update',
  'calculation', 'rule_change', 'goal_allocation', 'export', 'permission_grant',
  'permission_revoke', 'professional_access', 'archive', 'deletion',
  -- R2 (migration 0039)
  'document_uploaded', 'source_detected', 'parse_started', 'parse_failed',
  'parser_version_used', 'account_resolved', 'instrument_resolved',
  'reconciliation_case_created', 'reconciliation_case_resolved',
  'portfolio_certified', 'portfolio_certified_with_warnings', 'portfolio_failed',
  'document_superseded', 'document_processing_failed',
  -- R3 (spec section 47) — new
  'publication_previewed', 'publication_created', 'publication_confirmed',
  'manual_duplicate_linked', 'manual_record_superseded', 'publication_refreshed',
  'publication_superseded', 'publication_unpublished', 'publication_republished',
  'publication_failed', 'conflict_detected', 'conflict_resolved'
));

-- ===========================================================================
-- SECTION 5 — ii_reconciliation_cases: no new discrepancy_type values are
-- required — 'duplicate_suspected' (migration 0041) already covers the
-- manual/imported duplicate-candidate case a publication preview surfaces
-- (spec section 27), reused as-is rather than inventing a parallel
-- "publication conflict" entity (design principle: don't scatter dedup
-- concepts across new tables). subject_type is free text (not enum-
-- constrained) and already accepts 'holding_snapshot'; R3 additionally uses
-- the value 'publication_candidate' for cases opened during a publish
-- preview, which requires no schema change.
-- ===========================================================================
