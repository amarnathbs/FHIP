# R1 — Testing and Verification

Status: FINAL. Every result below reflects an actually-executed command or HTTP request — no PASS is reported without real evidence, per this project's standing verdict-honesty convention.

## A. Baseline regression — Before / After

| Command | Before (R1 start, branch `cef0786`) | After (R1 end, `d4e0a89`) | Delta |
|---|---|---|---|
| `npx eslint .` | Exit 1 — 6 pre-existing errors, 6 warnings (all in `components/grid/FinancialDataGrid.tsx`, `components/recommendations/RecommendationsPanel.tsx`, `components/ui/AppShell.tsx`, `components/marketing/LandingPage.tsx`, `components/reports/ReportPreview.tsx` — none touched by R1) | Exit 1 — same 6 errors, 6 warnings | **Zero new lint errors** |
| `npx tsc --noEmit -p tsconfig.json` | Exit 0 — clean | Exit 0 — clean | **Zero new type errors** |
| `npx vitest run` | Exit 0 — 124 passed (124), 14 test files | Exit 0 — **169 passed (169)**, 20 test files | **+45 new tests, zero regressions** |
| `next build` | Exit 0 — success | Exit 0 — success, including all 9 new `/api/investment-intelligence/*` routes compiled | **Zero build regressions** |

Note: the R0 baseline recorded 6 lint errors on `main` tip `fe7a094`; this R1 baseline was re-verified fresh at R1's own branch point (`cef0786`) per task section 7's explicit instruction, and found identical — confirming the baseline had not moved.

## B. Database constraint tests (DB-001 .. DB-012)

Every DB-* test requires the migrated schema on a real Postgres instance. **BLOCKED** for all 12 — see section G below for the precise, non-catastrophizing distinction between "blocked" and "known broken." Each was probed live against DEV and returned the identical, exact error: `PGRST205 — Could not find the table 'public.ii_sources' in the schema cache` (or the equivalent table name). Constraint correctness was instead verified by **hand-review of the migration SQL text** against each requirement:

| Test | Constraint reviewed | Live DEV result |
|---|---|---|
| DB-001 | Every required column is `not null` (e.g. `ii_accounts.institution_name`, `ii_transactions.gross_amount`) | BLOCKED |
| DB-002 | `owner_member_id`/`user_id` are real FKs (`references household_members(id)` / `references auth.users(id)`) | BLOCKED |
| DB-003 | Every relational column is a real FK with the correct target table | BLOCKED |
| DB-004 | Every lifecycle `status` column has an explicit `check (... in (...))` constraint | BLOCKED |
| DB-005 | `country_code`/`currency_code` are FKs into `countries`/`currencies`, not free text | BLOCKED |
| DB-006 | Two partial unique indexes on `ii_instrument_identifiers` (global vs. country-scoped schemes) | BLOCKED |
| DB-007 | `ii_source_documents.source_id`/`ii_prices_nav.source_id` are real FKs into `ii_sources` | BLOCKED |
| DB-008 | `ii_holding_snapshots.account_id`/`instrument_id` are real FKs | BLOCKED |
| DB-009 | RLS (owner-only) is the actual cross-household guard, not a naked FK — reviewed as present on every table (section RLS report) | BLOCKED |
| DB-010 | `ii_accounts.status` check includes `archived`; `listIiAccounts()` filters `neq('status','archived')` | BLOCKED |
| DB-011 | `ii_goal_allocations.effective_from` is `not null default current_date` | BLOCKED |
| DB-012 | `ii_instrument_identifiers`'s two partial unique indexes (same as DB-006) | BLOCKED |

## C. RLS security tests (SEC-001 .. SEC-012)

Run for real via `scripts/ii_r1_live_dev_security_tests.mjs` against DEV, using two genuinely-created auth test users (Household A / Household B, via the Auth Admin API — this succeeded independently of the DDL wall, since Auth admin is a separate Supabase subsystem).

| Test | Result | Evidence |
|---|---|---|
| SEC-001 (User A reads own records) | BLOCKED | `PGRST205` on `ii_source_documents` |
| SEC-002 (User A cannot read User B's) | BLOCKED | same |
| SEC-003 (User A cannot insert as User B) | BLOCKED | same, on `ii_accounts` |
| SEC-004 (User A cannot update User B's) | BLOCKED | same |
| SEC-005 (User A cannot delete User B's) | BLOCKED | same |
| SEC-006 (unauthenticated rejected) | BLOCKED | same |
| SEC-007 (private storage object isolation) | **PASS** | Real test against the live bucket — see `R1_SOURCE_STORAGE_REPORT.md` STOR-001/002 |
| SEC-008 (spoofed account/household ownership fails) | BLOCKED | same as SEC-003 |
| SEC-009 (cross-household relational references fail) | BLOCKED | same, on `ii_transactions` |
| SEC-010 (audit visibility follows policy) | BLOCKED | same, on `ii_audit_events` |
| SEC-011 (reference/master data read-ok, write-blocked) | BLOCKED | same, on `ii_sources` |
| SEC-012 (service-role confined to trusted server paths) | **PASS** | Code-review property, not live-HTTP-testable — every `createAdminClient()` call site enumerated in `R1_RLS_SECURITY_REPORT.md` section 6, confirmed none is reachable from an unauthenticated request path |

**Result: 0 FAIL, 2 PASS, 10 BLOCKED.** No cross-household leakage was found because no live test against the migrated schema could be executed at all — this is the testing-coverage gap the environment note in this task explicitly anticipated, not a discovered vulnerability. See section G.

## D. Storage security tests (STOR-001 .. STOR-008)

See `R1_SOURCE_STORAGE_REPORT.md` section 6 for the full table. Summary: **6 PASS** (STOR-001, 002, 003, 004, 006, 007), **1 PASS-with-caveat** (STOR-008, storage half proven, retention-policy half blocked), **1 BLOCKED** (STOR-005).

## E. Provenance tests (PROV-001 .. PROV-008)

All 8 require the migrated schema. **BLOCKED** for all 8, same exact `PGRST205` error pattern. Each mechanism was instead verified by hand-review of the migration/service-layer text:

| Test | Mechanism reviewed |
|---|---|
| PROV-001 | `ii_sources` table + migration `0038` seed rows (8 sources) |
| PROV-002 | `ii_source_documents.source_id → ii_sources(id)` FK |
| PROV-003 | `ii_source_documents` has no code path that ever `UPDATE`s `checksum`/`storage_path`/`original_filename` after insert (confirmed by reading every write to this table in `lib/services/investment-intelligence/*.ts` — only status/parse-lifecycle fields are ever updated) |
| PROV-004 | `manualImporter.ts`'s chain: every `ii_transactions`/`ii_holding_snapshots` row it creates carries `source_document_id` pointing back to the document it was derived from |
| PROV-005 | `manualImporter.ts`'s reconciliation-case branch opens a new `ii_reconciliation_cases` row rather than mutating the prior certified snapshot; the superseded-document branch sets `status='superseded'`/`superseded_by_document_id` on the OLD document row without touching its `checksum` |
| PROV-006 | Every `emitAuditEvent()` call site passes the real, just-created row's id as `subjectId` (verified by reading all 7 call sites) |
| PROV-007 | No code path in this codebase ever deletes or mutates `ii_transactions`/`ii_holding_snapshots` rows when a document is archived/superseded — confirmed by grep: no `DELETE`/`UPDATE` against those tables exists anywhere in `lib/services/investment-intelligence/` |
| PROV-008 | `computeFixtureChecksum()` is deterministic (unit-tested, `tests/unit/iiManualImporter.test.ts`) and `manualImporter.ts`'s idempotency check (`unique(user_id, checksum)` + an explicit pre-check) returns the existing chain rather than creating a duplicate — unit-tested for the checksum-determinism half; the full DB round-trip half is BLOCKED |

## F. India adapter tests (IN-001 .. IN-006)

| Test | Result | Evidence |
|---|---|---|
| IN-001 (`IN` resolves as valid country) | **PASS** | Live: `GET /rest/v1/countries?country_code=eq.IN` → `{"country_code":"IN","default_currency_code":"INR"}` |
| IN-002 (`INR` remains source currency) | **PASS** | Live: `GET /rest/v1/currencies?currency_code=eq.INR` → row returned |
| IN-003 (India source categories registrable) | BLOCKED | Needs `ii_sources` table; migration `0038`'s seed data hand-reviewed to confirm all 5 India-specific rows (`cams`/`kfintech`/`mfcentral`/`nsdl`/`cdsl`) are present in the SQL text |
| IN-004 (Indian MF identifier storable) | BLOCKED | Needs `ii_instrument_identifiers`; migration `0038` seeds 3 `amfi_scheme_code` rows in the SQL text |
| IN-005 (India structures don't contaminate global tables) | BLOCKED (live) / **PASS (design review)** | Hand-reviewed every column in migrations `0031`-`0036`: no India-only `not null` column exists anywhere on a core `ii_*` table; `pan`/`india_amc_code`/`india_tax_status`-shaped fields do not exist at all in R1 (not even nullable) — India-specific content lives only in migration `0038`'s **data**, never in schema |
| IN-006 (AU/AUD structural coexistence) | **PASS (schema half)** / BLOCKED (live insertion half) | Live: `countries`/`currencies` already carry `AU`/`AUD`. Design review: every `ii_*` migration types `country_code char(2)`/`currency_code char(3)` as generic FKs, never an `IN`/`INR`-only check constraint — a hypothetical `country='AU'`/`currency='AUD'` row requires zero schema change. Live row-insertion proof pending migration application. |

## G. The blocked-vs-broken distinction, stated explicitly

Every BLOCKED result above was produced by an actual HTTP request against the real DEV Supabase project, returning the actual PostgREST error `PGRST205` ("Could not find the table ... in the schema cache") — this is Postgres/PostgREST correctly reporting that the `ii_*` relations do not exist yet, because migrations `0031`-`0038` have not been applied to DEV (no session in this project has direct DDL access to DEV, and no local Postgres/Docker is available in this sandbox — both confirmed, see `R1_RLS_SECURITY_REPORT.md` section 1). This is categorically different from "tested and found broken": no security test here executed against a real schema and observed leakage; no constraint test executed against a real schema and observed a missing check. Per this task's own explicit instruction, this is a **testing-coverage gap**, correctly classified as **CONDITIONAL PASS** territory, not FAIL — see `R1_ACCEPTANCE_REPORT.md` section 25 for the full reasoning and the exact closure action.

## H. Existing FHIP regression (see also `R1_ACCEPTANCE_REPORT.md` for the checklist form)

`git diff --stat cef0786..HEAD -- . ':!docs/investment-intelligence' ':!supabase/migrations' ':!lib/services/investment-intelligence' ':!lib/validation/investment-intelligence.ts' ':!lib/fixtures' ':!app/api/investment-intelligence' ':!tests/unit/ii*' ':!scripts/ii_r1_live_dev_security_tests.mjs' ':!.gitignore'` returns **zero output** — confirming no existing file (any Dashboard/Assets/Investments/Retirement/Goals/Forecasting/Reports/Score/DNA/Resilience code, any pre-`0031` migration) was touched by R1 at all. Combined with the unchanged 124/124 baseline test count (now 169/169 including the 45 new II-only tests), this is direct, reproducible evidence that Net Worth, Forecasting, Goals, and Reports are byte-for-byte unchanged for any pre-existing user, since the exact code paths that compute them were not modified.
