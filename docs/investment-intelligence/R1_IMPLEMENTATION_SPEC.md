# R1 — Implementation Specification

Status: DRAFT — this is a plan for a future release. **Nothing in this document is implemented by R0. No migration exists yet.**
Depends on: every R0 document in `docs/investment-intelligence/` and `docs/investment-intelligence/adr/`.

This document translates the R0-certified architecture into a concrete, buildable R1 plan. It does not itself build anything — R0 ends when this specification is accepted, per the task's explicit instruction to stop before R1 begins.

## 1. Tables (first R1 migration, additive-only)

All 20 entities from `R0_CANONICAL_DATA_CONTRACT.md`, created in dependency order:

1. `ii_sources` (no dependencies)
2. `ii_instruments` (no dependencies)
3. `ii_instrument_identifiers` (→ `ii_instruments`)
4. `ii_source_documents` (→ `ii_sources`, `household_members`)
5. `ii_accounts` (→ `household_members`)
6. `ii_transactions` (→ `ii_accounts`, `ii_instruments`, `ii_source_documents`)
7. `ii_tax_lots` (→ `ii_accounts`, `ii_instruments`, `ii_transactions`)
8. `ii_holding_snapshots` (→ `ii_accounts`, `ii_instruments`, `ii_source_documents`)
9. `ii_prices_nav` (→ `ii_instruments`, `ii_sources`)
10. `ii_benchmarks` (no dependencies)
11. `ii_benchmark_series` (→ `ii_benchmarks`)
12. `ii_instrument_benchmarks` (→ `ii_instruments`, `ii_benchmarks`)
13. `ii_fund_holdings` (→ `ii_instruments`, `ii_sources`)
14. `ii_analytics_results` (→ user; subject polymorphic, no hard FK)
15. `ii_insights` (→ user)
16. `ii_reconciliation_cases` (→ user; subject polymorphic)
17. `ii_fhip_publications` (→ `ii_holding_snapshots`; `published_row_id` unenforced cross-table reference, app-validated — same pattern as `goal_funding_sources`' three nullable linked-id columns)
18. `ii_goal_allocations` (→ `user_goals`)
19. `ii_tax_rule_versions` (no dependencies)
20. `ii_audit_events` (no dependencies; nullable `user_id`)

Migration file naming continues the existing sequence (`R0_CURRENT_STATE_DISCOVERY.md` section 2 confirms `0030` is the current tip) — the first Investment Intelligence migration would be `0031_investment_intelligence_foundation.sql`, split further by table group if a single migration becomes unwieldy (precedent: Module 7's Goals spanned meaningful internal structure within one file, `0009`; Module 10's Forecasting spanned two files, `0013`+`0014`).

## 2. Columns, indexes, foreign keys, uniqueness constraints

Per-entity column lists are frozen in `R0_CANONICAL_DATA_CONTRACT.md` section 2 (required/optional split documented per entity). R1 must additionally specify, per existing FHIP convention (`R0_CURRENT_STATE_DISCOVERY.md` section 2 — every table has `idx_<table>_user` at minimum):

- `idx_ii_<table>_user` on every `user_id`-bearing table.
- `idx_ii_source_documents_status` (status is queried by any background parser worker picking up `uploaded`/`parsing` rows).
- `idx_ii_transactions_account_date` on `(account_id, transaction_date)`.
- `idx_ii_holding_snapshots_account_instrument_date` on `(account_id, instrument_id, as_of_date desc)` — the "latest snapshot" lookup.
- `idx_ii_prices_nav_instrument_date`, `unique(instrument_id, price_date)`.
- `idx_ii_benchmark_series_benchmark_date`, `unique(benchmark_id, series_date)`.
- `unique(ii_fhip_publications.canonical_position_id)` — the dedup-enforcing constraint (`ADR-004`).
- `unique(ii_instrument_identifiers.identifier_scheme, identifier_value)` where globally unique (ISIN), `unique(identifier_scheme, identifier_value, country_code)` where country-scoped (AMFI codes) — two partial unique indexes, not one, since the uniqueness scope differs by scheme.
- `unique(ii_source_documents.user_id, checksum)` where `checksum is not null` — re-upload detection.

## 3. RLS

Per `R0_SECURITY_RLS_ARCHITECTURE.md`: every user-owned `ii_*` table gets exactly `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`, identical to every existing table. Reference tables (`ii_sources`, `ii_instruments`, `ii_instrument_identifiers`, `ii_prices_nav`, `ii_benchmarks`, `ii_benchmark_series`, `ii_instrument_benchmarks`, `ii_fund_holdings`, `ii_tax_rule_versions`) get `for select using (true)`, writable only through the service-role admin path gated by `requireAdmin()`. `ii_audit_events` gets `for select using (auth.uid() = user_id)` **only** — no insert/update/delete policy for the authenticated role at all; all writes happen through the service-role client from within trusted server-side code paths, never directly from a user-facing insert.

## 4. Storage bucket design

New private bucket `investment-source-documents`, mirroring `report-exports` exactly (`R0_SOURCE_PROVENANCE_CONTRACT.md` section 4): service-role-only write (upload handled server-side after RLS-gated authorization check, never a direct client-to-bucket upload), signed-URL-only read with a short expiry (matching `report-exports`' 60-second signed URL, `R0_CURRENT_STATE_DISCOVERY.md` section 9), object path scoped by `user_id` to make an accidental cross-user path guess non-functional even before RLS/signed-URL protection is considered.

## 5. Source upload lifecycle

`uploaded` (file stored, `ii_source_documents` row created) → `parsing` (worker picked it up) → `parsed` (success — `ii_transactions`/`ii_holding_snapshots` created) or `parse_failed` (error recorded, original file untouched, user can retry or contact support) → optionally `superseded` (a newer upload for the same account supersedes it) → `archived`. Every transition emits the corresponding `ii_audit_events` row (`R0_AUDIT_REQUIREMENTS.md`).

## 6. Audit implementation

Wrap every mutating Investment Intelligence service function analogous to how `adminRoute()` wraps admin handlers today (`R0_CURRENT_STATE_DISCOVERY.md` section 10) — a shared helper that, on successful completion of a tracked operation, inserts the corresponding `ii_audit_events` row via the service-role client (since the authenticated RLS policy intentionally has no insert permission, per section 3 above). All 19 event types from `R0_AUDIT_REQUIREMENTS.md` section 2 must have at least one call site by the end of R1's own acceptance gate.

## 7. India adapter shell

R1 builds the **shell only** — no parser, no analytics (explicit non-goal, repeated here to avoid scope creep during implementation):
- `ii_sources` seeded with `cams`, `kfintech`, `mfcentral`, `nsdl`, `cdsl`, `broker`, `manual`, `admin_correction`.
- `ii_instrument_identifiers.identifier_scheme` seeded/enumerated with `isin`, `amfi_scheme_code`, `nse_symbol`, `bse_code`, `internal_provisional`.
- Country-scoping (`country_code='IN'`) applied consistently on every adapter-contributed reference row.
- No CAMS/KFintech/NSDL/CDSL file-format parsing logic of any kind.

## 8. Manual test importer

A minimal, developer/QA-only tool (not a consumer feature) that lets a real `ii_source_documents`/`ii_transactions`/`ii_holding_snapshots` chain be created via a fixture JSON file rather than a real parser — the same role `supabase/seed_master_items.sql`-style fixtures play for other modules. Purpose: unblocks R1's own integration/publishing tests (section 12 below) without building the CAS parser the task explicitly forbids in this release.

## 9. API contracts

Following the existing `makeRegistry()`/`requireUser()`/`ok()`/`bad()` pattern (`R0_CURRENT_STATE_DISCOVERY.md` section 4) wherever it fits (simple owner-scoped CRUD on `ii_accounts`, `ii_goal_allocations`), plus new, purpose-specific routes for operations `makeRegistry()` doesn't fit:

- `POST /api/investment-intelligence/source-documents` — upload (service-role storage write behind an authenticated, RLS-checked request).
- `POST /api/investment-intelligence/source-documents/[id]/parse` — trigger parse (manual-test-importer-backed in R1, not a real parser).
- `GET /api/investment-intelligence/positions` — list canonical positions for the user.
- `POST /api/investment-intelligence/positions/[id]/publish` — publish per `R0_FHIP_PUBLISHING_CONTRACT.md`, blocking on unmapped owner.
- `POST /api/investment-intelligence/reconciliation-cases/[id]/resolve` — resolve a reconciliation case.
- `POST /api/investment-intelligence/goal-allocations` — create/update, writing through to `goal_funding_sources` per `ADR-006`.

Every route follows the existing `requireUser()` guard; admin-only reference-data routes follow `requireAdmin()`/`adminRoute()`.

## 10. Migrations and rollback strategy

Additive-only migration(s), matching the existing platform's convention of forward-only numbered migrations with no down-migrations found anywhere in `supabase/migrations/` (`R0_CURRENT_STATE_DISCOVERY.md` section 2 — confirmed none of the 30 existing migrations ship a rollback script). Rollback strategy for R1, consistent with this precedent: a failed/incorrect migration is corrected by a new forward migration, never a destructive down-migration against a table that may already hold real user data by the time a fix is needed. Pre-migration: full schema-only dump of the affected tables' definitions for review; the migration is tested first against the DEV Supabase project before any future production application (production is never touched by this or any R0/R1 work).

## 11. Seed / reference records

`ii_sources` (section 7), `countries`/`currencies` reused as-is (no new rows needed — R1 introduces no new country/currency support beyond the existing `AU`/`IN`), a small `ii_instruments` seed of common India mutual-fund/index instruments for manual-test-importer fixtures to reference (not a real AMFI master feed import — out of scope).

## 12. Test fixtures

JSON fixtures for the manual test importer (section 8) representing: a simple single-fund CAS import, a multi-fund CAS import, a refreshed/superseding statement, a discrepant reconciliation case, an NPS account, a term-deposit-equivalent account — covering the scenario matrix in `R0_NET_WORTH_DEDUP_CONTRACT.md` section 2 as concrete data, not just prose.

## 13. Unit tests

Following the existing `vitest` convention (124 tests across 14 files today, `R0_TESTING_AND_VERIFICATION.md` section A) — new test files under a parallel `lib/engines/investment-intelligence/*.test.ts`/`lib/services/investment-intelligence/*.test.ts` structure (mirroring `lib/engines/goalMath.test.ts`-style existing tests) covering: identifier alias resolution, publication target routing (`R0_NET_WORTH_DEDUP_CONTRACT.md` section 1's routing rules), the `include_in_net_worth` exclusion behaviour, `ii_goal_allocations` ↔ `goal_funding_sources` sync.

## 14. Integration tests

End-to-end (against the DEV Supabase project only, never production): upload fixture → parse (manual importer) → reconcile → publish → confirm `computeDashboard()`'s `totalInvestments`/`netWorth` reflects the published value exactly once → confirm a second publish attempt for the same canonical position updates rather than duplicates → confirm archiving removes it from the sum → confirm a goal allocation created through Investment Intelligence is respected by `checkFundingAllocation()`'s existing cap logic.

## 15. Security tests

Cross-user RLS rejection test (`ADR-009`) for every new `ii_*` table; storage bucket signed-URL expiry test; admin-route rejection test for a non-admin user attempting to write `ii_sources`/`ii_instruments` reference data; `ii_audit_events` insert-rejection test for the authenticated (non-service-role) client.

## 16. Acceptance gate (R1's own, distinct from R0's)

R1 is not complete until: every table/index/constraint in sections 1–2 exists in DEV; every RLS policy in section 3 is verified by an actual cross-user test, not just written; the storage bucket behaves per section 4; the India adapter shell (section 7) contains no parsing logic; the 12-scenario dedup matrix (`R0_NET_WORTH_DEDUP_CONTRACT.md`) passes as real integration tests, not design tests; baseline lint/typecheck/test/build remain healthy exactly as R0's own gate required (`R0_TESTING_AND_VERIFICATION.md` section A); and a genuine R1 acceptance report is written following the same honest PASS/CONDITIONAL PASS/FAIL discipline this R0 report follows (`R0_ACCEPTANCE_REPORT.md`).

## 17. Explicit R1 non-goals (carried forward from this release's own non-goals, restated so R1 doesn't scope-creep)

No CAS parser. No performance/tax/X-ray analytics. No adviser features. No redesign of unrelated FHIP screens. No removal/rewrite of existing working modules. No production Investment Intelligence functionality beyond the shell described above — R1's own purpose is to stand up the certified schema and plumbing, not to deliver the eventual product experience.
