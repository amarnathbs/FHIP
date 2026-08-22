# R1 — Implementation Report

Status: FINAL
Branch: `feature/investment-intelligence-r1-data-foundation` (from R0 completion commit `cef0786`, on `feature/investment-intelligence-r0-architecture`)
R1 commits: `0917939`, `55f0ebe`, `5733494`, `d4e0a89` (HEAD)
Date: 2026-08-19

## 1. What was implemented

- All 20 canonical `ii_*` entities frozen in `R0_CANONICAL_DATA_CONTRACT.md`, created in dependency order across migrations `0031`-`0036`, exactly as `R1_IMPLEMENTATION_SPEC.md` section 1 specifies.
- RLS on every table: owner-only (`auth.uid() = user_id`) on every user-owned entity, world-read/admin-write on every reference entity, select-only (no insert/update/delete for any authenticated role) on `ii_audit_events`.
- A real private Supabase Storage bucket, `investment-source-documents`, created live on the DEV project via the Storage Admin API — not a design description, an actually-existing bucket with `public=false`, `file_size_limit=20MB`, `allowed_mime_types=[application/pdf, text/csv]` (verified: see `R1_SOURCE_STORAGE_REPORT.md`).
- The `storage.objects` RLS policy for that bucket (migration `0037`), following the `report-exports` precedent exactly.
- The India adapter shell: 8 `ii_sources` rows, 5 fixture `ii_instruments` + their `ii_instrument_identifiers`, all clearly marked as non-authoritative test fixtures (migration `0038`).
- A full service layer (`lib/services/investment-intelligence/`): audit event emission, ADR-002 identifier alias resolution, owner-scoped account CRUD, the FHIP-publication routing/dedup mechanism (structural only), the goal-allocation sync mapping, storage validation/upload/signed-URL helpers, and the consumer-facing advice-gate filter.
- The controlled, deterministic manual/test importer (`lib/services/investment-intelligence/manualImporter.ts`) proving the full chain: validated fixture → `ii_source_documents` → `ii_accounts` → `ii_instruments`/`ii_instrument_identifiers` → `ii_transactions` → `ii_holding_snapshots` → provenance → audit — with checksum-based idempotency, supersession chaining, and reconciliation-case opening.
- 7 fixture files covering all 6 scenarios `R1_IMPLEMENTATION_SPEC.md` section 12 requires, plus an independent Household B fixture for cross-household security testing.
- 9 API routes under `app/api/investment-intelligence/`, every one gated by `requireUser()`, none exposing unrestricted generic CRUD over `ii_*` tables.
- 45 new unit tests (`tests/unit/ii*.test.ts`) covering every pure/logic-bearing function the spec's section 13 names.
- A genuine live-DEV test pack (`scripts/ii_r1_live_dev_security_tests.mjs`) executed against the real DEV Supabase project, in the project's established fail-closed style.

## 2. What was deliberately deferred (R1 non-goals, honoured)

No CAMS/KFintech/NSDL/CDSL/broker CAS parser of any kind. No production OCR/parsing workflow. No automatic scheme reconciliation. No portfolio-truth certification. No XIRR/CAGR/TWRR engine. No benchmark/blended-benchmark calculation. No SIP analytics. No fund overlap/look-through/X-ray analytics. No tax/exit-load/regular-vs-direct cost calculation. No investment recommendations or adviser workflow. No Investment Intelligence premium report. **No active FHIP publication** — `ii_fhip_publications` rows are created and tested, but `published_row_id` is always `null` and no row is ever written into `assets`/`investments`/`retirement_accounts` by any R1 code path. No new net-worth calculation of any kind.

## 3. Migrations (see `R1_DATABASE_SCHEMA.md` for the full per-table breakdown)

`supabase/migrations/0031` through `0038`, eight files, additive-only, dependency-ordered, no historical migration modified. Numbering starts at `0031` (see section 8, "Deviation: migration numbering," below).

## 4. Services / APIs

See `lib/services/investment-intelligence/*.ts` and `app/api/investment-intelligence/**/route.ts`. Every mutating service function that represents a tracked R1 lifecycle event calls `emitAuditEvent()` (the one insert call site for `ii_audit_events`, using the service-role client since the table intentionally carries no authenticated-role insert policy).

## 5. Database entities

All 20, per `R0_CANONICAL_DATA_CONTRACT.md`. Full table-by-table detail in `R1_DATABASE_SCHEMA.md`.

## 6. India adapter

Shell only, per spec section 26. `country='IN'`, `INR` as source currency, 8 `ii_sources` rows (`cams`, `kfintech`, `mfcentral`, `nsdl`, `cdsl`, `broker`, `manual`, `admin_correction`), 5 fixture instruments. No AMFI NAV download, no benchmark history population, no tax rates, no scheme analytics, no CAS parser — confirmed by `grep -ri "cams\|kfintech\|nsdl\|cdsl" lib/ app/` returning only the enum/seed-value occurrences already described here, never a parsing routine.

## 7. Storage

Real, live, private bucket on DEV. See `R1_SOURCE_STORAGE_REPORT.md`.

## 8. Deviations from the spec (documented, not silent)

1. **Migration numbering starts at `0031`, not `0041`.** The task's pre-confirmed fact ("latest existing migration is `0040`") was verified against this branch's actual git history to be incorrect for this branch specifically: this branch was created from R0's completion commit (`cef0786`), which branches from `main` tip `fe7a094` — and `main`'s own `supabase/migrations/` directory tops out at `0030`, confirmed by both direct inspection (`git ls-tree -r --name-only main -- supabase/migrations`) and by `R1_IMPLEMENTATION_SPEC.md` section 1's own text, which explicitly names `0031_investment_intelligence_foundation.sql` as the first Investment Intelligence migration. Migrations `0031`-`0040` do exist, but only on other, still-unmerged feature branches (the Resources CMS R1.1-R1.6 work) that this branch's history does not contain. **This is a real, named risk**: if those other branches merge to `main` before this one, there will be a filename collision at the `0031`-`0038` range requiring renumbering at integration time. This is flagged here explicitly rather than silently avoided by guessing a higher number that would leave a false gap in this branch's own migration sequence.
2. **`ii_goal_allocations.investment_position_id` and `ii_analytics_results`/`ii_reconciliation_cases`' `subject_id` are plain `uuid` columns with no enforced FK**, matching the same "app-validated, polymorphic reference" pattern R0 already sanctioned for `ii_fhip_publications.published_row_id`. This is not a new pattern invented for R1 — it is the identical discipline the R0 architecture already required for exactly this class of "points at one of several possible tables" reference.
3. **NPS-classified instruments use `instrument_class='other'`**, not a dedicated retirement value, because the R0-frozen `ii_instruments.instrument_class` enum has no such value and R1 does not amend a frozen R0 enum without a documented architecture exception (see `R1_ARCHITECTURE_EXCEPTION.md` — none was needed). Publish-target routing for retirement-type positions instead keys off `ii_accounts.account_type='retirement'`, which already exists in the frozen `ii_accounts` schema and requires no change. This reasoning and its test coverage are in `tests/unit/iiPublishing.test.ts`.

## 9. Known limitations

- **RLS/security tests could not be executed against any real Postgres instance** (local or DEV) in this sandbox — no Docker/Podman is installed (confirmed: absent from PATH, no Docker Desktop install found anywhere searched), so `npx supabase start` fails at the Docker-lifecycle-inspection step, and there is no direct Postgres connection string to DEV (the same wall every migration-dependent phase in this project's history has hit, `0033` through `0040`). This is a **testing-coverage gap**, not a known security failure — see `R1_RLS_SECURITY_REPORT.md` and `R1_ACCEPTANCE_REPORT.md` for the precise, evidence-backed distinction and the exact closure action.
- The manual test importer's `supersedesFixtureKey` resolution takes "the user's most recently parsed document" rather than matching a stored fixture-key tag (no such column exists on the frozen `ii_source_documents` schema) — sufficient for this repo's single-fixture-chain test scenarios, not a general-purpose supersession matcher.
- `ii_source_documents` upload metadata (`document_type`) validation is enum-based per the frozen schema; a real CAS-vs-demat-vs-contract-note classification step does not exist (out of scope — no parser).

## 10. Exact R2 scope

Per `R1_ACCEPTANCE_REPORT.md` section "Exact Prerequisites for R2": a real CAMS/KFintech/NSDL/CDSL parser, activation of the actual `assets`/`investments`/`retirement_accounts` cross-register write inside `publishPositionStructural()`, reconciliation UX, XIRR/performance analytics, benchmark ingestion, and — as a hard prerequisite before any of that — migrations `0031`-`0038` applied to DEV and the full SEC-*/DB-*/PROV-*/IN-* test pack re-run for real.
