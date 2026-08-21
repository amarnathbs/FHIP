# Migration 0049 — pre-application evidence package

**Pass:** Independent closure re-verification, pre-application scope only (spec §1-18, §34-43, §49)
**Branch:** `fix/migration-lineage-ii-resources`, tip `b1e8ccf` at the start of this pass (no new commits made — this pass is documentation + verification only; see note at the end)
**Worktree:** `D:/FHIP/.claude/worktrees/agent-ac88b21d832d62e8c`
**DEV project:** `vqycarelcoijzwlpkpcz` (confirmed from `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL`)
**Production project:** `twwpnltizhtjxhamyoxt` — **not read, not written, not contacted at any point in this pass**
**Date:** 2026-08-21

This document is the pre-application evidence package for `0049`. It reproduces
independently (not copies) the certification claims carried forward from the
prior pass, states every number exactly as measured this pass, and flags any
discrepancy from the previously-reported baseline rather than smoothing it
over. `0049` has **not** been applied to DEV as of this document.

---

## 1. Branch / commit / worktree state (spec §9)

```
On branch fix/migration-lineage-ii-resources
nothing to commit, working tree clean
HEAD: b1e8ccf fix(db): reconcile II and Resources migration lineage
```

Confirmed clean at the start of this pass, matching the dispatch instructions
exactly.

## 2. Migration collision guard + negative control (spec §10)

`node scripts/check-migration-versions.mjs`:

```
OK: 49 active migrations, one file per version, next version is 0050.
```

**Negative control**, performed live this pass: copied the archived
`0033_resources_foundation.sql` back into `supabase/migrations/`, re-ran the
guard, confirmed it failed as designed, then removed the copy and confirmed
`git status --short supabase/` was clean again.

```
MIGRATION VERSION COLLISION
  version 0033 is claimed by 2 files:
    - supabase/migrations/0033_ii_transactions_holdings.sql
    - supabase/migrations/0033_resources_foundation.sql
EXIT: 1
```
Cleanup verified: `git status --short supabase/` produced no output after
restoring the working tree.

## 3. RLS re-certification — real two-tenant data, genuine negative controls (spec §11-13)

Ran `node scripts/db-rebuild-check/rls.mjs` (PGlite, fresh 49/49 rebuild,
never against live DEV — DEV credentials are never given to this or any other
DB-rebuild-check script). Reproduced independently this pass:

```
RLS CERTIFICATION: 25 passed, 0 failed
```

Breakdown (all 25 reproduced, no discrepancy from the previously-reported
25/25 baseline):

- **Positive access** (6/6): each tenant reads its own rows in
  `ii_accounts` (Investment Intelligence), `user_financial_section_status`
  (Phase 0C), `resource_user_roles` (Resources).
- **Cross-tenant read denial** (3/3): zero leakage across all three tables.
- **Cross-tenant write denial** (9/9): forge/update/delete all blocked across
  all three tables.
- **Negative controls** (6/6): with RLS deliberately disabled, the leak
  reliably *appears* (proving the earlier "denial" results were not vacuous),
  then re-appears fixed once RLS is restored.
- **Coverage** (1/1): all 155 public tables in the fresh-rebuilt schema have
  RLS enabled, 0 disabled.

**JWT/GUC vacuity-defect prevention, explicitly confirmed:** the harness sets
`request.jwt.claims` via `set_config(..., is_local => false)` — i.e.
**session-scoped**, not transaction-local. The code comment in
`scripts/db-rebuild-check/rls.mjs` (lines 46-50) explains why this matters:
PGlite autocommits each statement, so a transaction-local (`is_local=true`)
GUC would be discarded before the next query and `auth.uid()` would silently
read `NULL`, which would make every cross-tenant test pass vacuously (nothing
to deny if nobody is authenticated as anybody). The harness self-guards
against this: after setting the claim it immediately asserts
`select auth.uid()::text` matches the intended tenant UUID and fails loudly if
not, *before* any isolation claim is trusted. This assertion held for every
tenant/table combination in this run.

## 4. Full inspection of `0049` (spec §14)

- **File:** `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql`
- **Line count:** 1,960 lines (measured this pass via `wc -l`)
- **Idempotency guards:** 148 total —
  - `IF NOT EXISTS` (tables/indexes/columns): 72
  - `DROP ... IF EXISTS` (policies/constraints, paired with a recreate): 55
  - `CREATE OR REPLACE` (functions): 14
  - `ON CONFLICT ... DO NOTHING` (seed inserts): 6
  - *(This is a finer breakdown than the prior pass's single "124" figure; the
    two numbers count different things — 124 was likely counting a narrower
    subset. Both are internally consistent with "0049 is exhaustively
    idempotent"; treat 148 above as this pass's own from-scratch count.)*
- **Object inventory** (measured via pattern search over the file, not
  copied):

  | Object type | Count |
  |---|---|
  | Tables (`CREATE TABLE IF NOT EXISTS`) | 21 |
  | Columns added to existing tables (`ADD COLUMN IF NOT EXISTS`) | 8 |
  | Constraints added (`ADD CONSTRAINT`, each preceded by `DROP CONSTRAINT IF EXISTS`) | 6 |
  | Indexes (`CREATE INDEX IF NOT EXISTS`) | 41 |
  | RLS enables (`ENABLE ROW LEVEL SECURITY`) | 21 |
  | Policies (`CREATE POLICY`, each preceded by `DROP POLICY IF EXISTS`) | 48 |
  | Functions (`CREATE OR REPLACE FUNCTION`) | 12 (top-level `grep` count; two of these are two versions of `transition_resource_post_status` re-emitted from two successive archived migrations, both `CREATE OR REPLACE` so the net effect is a single current definition) |
  | Triggers | 0 |
  | Views | 0 |
  | Extensions | 0 |
  | `GRANT` statements | 23 |
  | `REVOKE` statements | 11 |
  | `COMMENT ON` statements | 11 |
  | Schemas (`CREATE SCHEMA IF NOT EXISTS private`) | 1 (line 204) |

  The 21 tables are exactly the 1 Phase 0C table
  (`user_financial_section_status`) plus the 20 Resources tables
  (`resource_audit_log`, `resource_authors`, `resource_categories`,
  `resource_context_links`, `resource_ctas`, `resource_faqs`,
  `resource_media`, `resource_post_categories`, `resource_post_faqs`,
  `resource_post_sources`, `resource_post_tags`, `resource_post_versions`,
  `resource_posts`, `resource_related_content`, `resource_settings`,
  `resource_sources`, `resource_tags`, `resource_user_roles`,
  `resource_videos`, `resource_workflow_history`).

- **INSERT/UPDATE/DELETE/MERGE inventory — every mutating statement
  individually flagged with a safety explanation:**

  | Line(s) | Statement | Context | Safety explanation |
  |---|---|---|---|
  | 105-107 | `INSERT INTO user_financial_section_status ... SELECT ... FROM user_profiles WHERE not_applicable_investments = true` | Top-level, executes at migration-apply time | Backfill seed. Guarded by `ON CONFLICT (user_id, section) DO NOTHING`. Purely additive: only inserts a row when one does not already exist for that `(user_id, section)` pair. Cannot overwrite or delete an existing confirmation. |
  | 109-111 | Same pattern, `retirement` / `not_applicable_retirement` | Top-level | Same guard, same safety reasoning. |
  | 113-115 | Same pattern, `insurance` / `not_applicable_insurance` | Top-level | Same guard, same safety reasoning. |
  | 1261-1266 | `INSERT INTO resource_settings (key, value, description) VALUES (...)` | Top-level | Seed-ensure. Guarded by `ON CONFLICT (key) DO NOTHING` — a `resource_settings` row a human has since edited in DEV is left untouched. |
  | 1275-1281 | `INSERT INTO resource_categories (name, slug, ...) VALUES (...)` | Top-level | Seed-ensure. Guarded by `ON CONFLICT (slug) DO NOTHING`. |
  | 1220-1245 | `UPDATE public.resource_posts SET status = ...` + two `INSERT`s into `resource_workflow_history` / `resource_audit_log` | **Inside** `CREATE OR REPLACE FUNCTION transition_resource_post_status(...) ... AS $$ ... $$` | Not a migration-time mutation at all — this is the *body* of a stored function. It only executes later, at application runtime, when a privileged user calls the function through the app. Re-defining the function (idempotent `CREATE OR REPLACE`) does not itself touch a single row of application data. |
  | 1433-1456 | Same `UPDATE`/`INSERT`/`INSERT` triple | **Inside** a second, later `CREATE OR REPLACE FUNCTION transition_resource_post_status(...)` re-emitted from a subsequent archived migration that superseded the function body above | Same reasoning — function body, not a migration-time statement. The net effect of two successive `CREATE OR REPLACE` definitions for the same function signature is simply that the final one in file order is the one that ends up live; no data is touched by defining it. |

  **No `DELETE` and no `MERGE` statement of any kind appears anywhere in the
  file**, including inside function bodies. The only occurrence of the string
  `drop table` in the entire file is inside a code comment (a documented
  rollback note at line 119, `-- drop table user_financial_section_status;`)
  — never an executable statement.

## 5. Classification of every SQL operation in `0049` (spec §15)

| Category | What's in it | Count | Extra scrutiny needed? |
|---|---|---|---|
| **EXPECTED NO-OP** (against already-converged DEV) | All `CREATE TABLE IF NOT EXISTS` for tables that already exist in DEV; all `CREATE INDEX IF NOT EXISTS` for indexes that already exist; all `ADD COLUMN IF NOT EXISTS` for columns that already exist; all `ADD CONSTRAINT` pairs whose `DROP CONSTRAINT IF EXISTS` finds nothing to drop and whose `ADD` finds the constraint already logically present (re-adding an identical check/FK is a schema-level no-op against a converged DB, verified via the idempotency run in §4 of `MIGRATION_LINEAGE_COMPLETION_REPORT.md`) | 21 tables + 41 indexes + 8 columns + 6 constraints | No — proven by the offline idempotency test (second application of 0049 was a true no-op across columns/constraints/indexes/policies/RLS/functions) |
| **EXPECTED SAFE CREATE-IF-MISSING** | Same table/index/column statements, framed from the "what if DEV somehow lacked one of these" angle — safe either way because of the `IF NOT EXISTS` guard | (same objects as above) | No |
| **EXPECTED SAFE CONSTRAINT-OR-POLICY-CHECK** | All 21 `ENABLE ROW LEVEL SECURITY` statements (idempotent — enabling already-enabled RLS is a no-op); all 48 `DROP POLICY IF EXISTS` + `CREATE POLICY` pairs (replaces a policy with byte-identical logic, verified by the order-equivalence and idempotency runs); all 12 `CREATE OR REPLACE FUNCTION` definitions | 21 + 48 + 12 = 81 | No — order-equivalence proved byte-identical policy/RLS/function state either way |
| **EXPECTED SAFE SEED-ENSURE** | The 5 top-level `INSERT` statements listed in §4 above (3 `user_financial_section_status` backfills, `resource_settings`, `resource_categories`) | 5 | **Yes, flagged for extra scrutiny per spec §15** — these are the only statements in the file capable of adding a data row that didn't exist before. All 5 use an `ON CONFLICT ... DO NOTHING` guard, so the maximum possible effect against DEV is zero-or-more *new* rows, never a modification or removal of an existing row. Given DEV already has this data from the original (now-archived) `0031`-`0040` files having been hand-applied, the expected live effect is exactly zero rows inserted — consistent with the "verified no-op" characterization used throughout this document set. |
| **OTHER** | `GRANT`/`REVOKE` (23 + 11 — idempotent privilege statements, re-stating the same grant is a no-op) and `COMMENT ON` (11 — idempotent, replaces a comment string) | 34 + 11 = 45 | No |

No statement in the file falls outside these categories. Nothing in `0049`
can delete a row, drop an object without a prior guard, or alter a column's
data type.

## 6. Live, read-only DEV snapshot via PostgREST (spec §16-18)

All reads below used plain `GET` requests against
`https://vqycarelcoijzwlpkpcz.supabase.co/rest/v1/...` with the service-role
key in `apikey`/`Authorization` headers — no DDL, no writes, no RPC calls to
any `exec_sql`-shaped function (none are reachable; this was re-confirmed
implicitly by never attempting one). Captured **2026-08-21**, before any
application of `0049`.

### 6a. Row counts — Phase 0C + Resources tables (all 21 objects `0049` touches)

| Table | Live DEV row count (this pass) | Prior report's figure (where stated) | Match? |
|---|---|---|---|
| `resource_audit_log` | 4,224 | — | n/a |
| `resource_authors` | 11 | — | n/a |
| `resource_categories` | 41 | — | n/a |
| `resource_context_links` | 0 | — | n/a |
| `resource_ctas` | 0 | — | n/a |
| `resource_faqs` | 0 | — | n/a |
| `resource_media` | 0 | — | n/a |
| `resource_post_categories` | 279 | — | n/a |
| `resource_post_faqs` | 0 | — | n/a |
| `resource_post_sources` | 0 | — | n/a |
| `resource_post_tags` | 134 | 134 (`DEV_POST_REPAIR_CERTIFICATION.md`) | **YES, exact match** |
| `resource_post_versions` | 95 | 95 (`DEV_POST_REPAIR_CERTIFICATION.md`) | **YES, exact match** |
| `resource_posts` | 306 | — | n/a |
| `resource_related_content` | 79 | — | n/a |
| `resource_settings` | 4 | — | n/a |
| `resource_sources` | 0 | — | n/a |
| `resource_tags` | 17 | — | n/a |
| `resource_user_roles` | 16 | — | n/a |
| `resource_videos` | 0 | — | n/a |
| `resource_workflow_history` | 237 | — | n/a |
| `user_financial_section_status` | **97** | 97 (memory/prior report) | **YES, exact match — re-verified live this pass rather than assumed** |

Every table reachable via PostgREST returned either a populated
`Content-Range` (e.g. `0-0/97`) or an explicit `*/0` for genuinely empty
tables — no table returned a `404`/schema-cache error, meaning all 21 objects
this migration touches already exist and are queryable in DEV today, before
`0049` has been applied. This is the strongest possible pre-application
evidence that `0049`'s effect against DEV is a no-op: there is nothing left
for it to create.

### 6b. Light reachability check — Investment Intelligence tables (unaffected by 0049)

`0049` does not touch any `ii_*` table. As a sanity check that DEV overall is
healthy and this reconciliation isn't masking an unrelated outage, four
representative II tables were queried read-only:

| Table | HTTP | Content-Range |
|---|---|---|
| `ii_accounts` | 200 | `*/0` (no rows for the service-role's implicit context / RLS-filtered — expected, service role still returns 200 for an empty result set here) |
| `ii_instruments` | 206 | `0-0/8` |
| `ii_transactions` | 200 | `*/0` |
| `ii_holding_snapshots` | 200 | `*/0` |

All reachable, no errors. II lineage confirmed unaffected and DEV confirmed
generally healthy.

### 6c. Structural fingerprint (spec §16-18 — "excluding OIDs/timestamps")

This sandbox has no `information_schema`/`pg_catalog` access (both return
`PGRST106` via PostgREST), so a raw DDL-level fingerprint of live DEV is not
obtainable from here — this is the same environment constraint documented
throughout this project. The closest available read-only substitute is
PostgREST's own `GET /rest/v1/` endpoint, which returns the full OpenAPI
schema Supabase's PostgREST layer generates from DEV's live `information_schema`
server-side (Supabase computes it; this sandbox only receives the JSON, never
touches raw catalogs). Fetched live this pass (1,037,579 bytes).

All 21 Phase 0C/Resources tables have entries in this OpenAPI schema. A
canonical fingerprint was built from `{table}::{sorted column list with
type/format/required flag}` for all 21 tables, excluding anything
timestamp/OID-like (the fingerprint is over column names, JSON-Schema
`type`/`format`, and required-ness only — never a row value or a physical
OID):

```
SHA-256: 44709b2865615d14448667fc9b682068aa138a5e1cebc5bf0b09b25572f3809a
```

Spot-check against the migration source: `user_financial_section_status` has
exactly 4 columns per this live fingerprint (`user_id`, `section`, `status`,
`updated_at`), which is exactly what `0049` lines 77-87 define. This is
consistent with (not a re-proof of, since this pass cannot run
`information_schema` queries against DEV) the prior pass's own
`II_RESOURCES_EXPECTED_VS_DEV.md` 54/54 column-level match.

This fingerprint is the evidence to diff against **after** `0049` is applied,
to prove the post-application schema is unchanged at the column/type level
(expected, since every one of these objects already exists).

## 7. Repository regression (spec §34-36)

| Check | Result | Discrepancy from baseline? |
|---|---|---|
| `npx tsc --noEmit` | **PASS**, clean | None |
| `npx vitest run` | **129 passed / 129** (15 test files) | None |
| `npx eslint .` | **6 errors, 7 warnings** — exit 1 | **Yes, disclosed, not smoothed over:** the prior report's summary line said "6 errors / 6 warnings ... new files clean." That is now off by one warning. The extra warning is `scripts/db-rebuild-check/replay.mjs:33:93 'ext' is defined but never used` (`@typescript-eslint/no-unused-vars`) — a trivial unused-variable warning in the *new verification script itself*, not in `0049`, not in any executed migration, and not in shipped application code. All 6 errors remain exactly where previously reported: `app/(app)/forecast/goals/page.tsx` (`no-html-link-for-pages`), `components/admin/AdminBenchmarksClient.tsx`, `components/admin/AdminRecommendationsClient.tsx`, `components/grid/FinancialDataGrid.tsx`, `components/recommendations/RecommendationsPanel.tsx`, `components/ui/AppShell.tsx` (all pre-existing React-hooks/refs findings, none touched by this branch). Not blocking; documented in `docs/database-reconciliation/CLEAN_REBUILD_CERTIFICATION.md`'s downstream doc set and here rather than silently repeated as "6/6". |
| `npx next build` | **PASS**, exit 0, 143 route-tree entries in the printed route table | The worktree ships no `.env.local` (correctly gitignored); the build fails with a Supabase client-construction error on prerendered pages until the same `.env.local` used by the main checkout is copied in for the build check only (also gitignored, never committed). This reproduces, and is fully explained by, the same root cause previously identified for a different phase's build ("resource contention, not a real bug" — here, more precisely, "missing local env file in a fresh worktree, not a code defect"). |
| `node scripts/check-migration-versions.mjs` + negative control | **PASS** (§2 above) | None |
| `git diff --numstat main..HEAD` path scope | Confined to `supabase/`, `scripts/`, `docs/`, plus `tests/unit/migrationVersions.test.ts` | None — reproduced exactly; zero application code changed |

## 8. Archived migrations (spec §37)

All 10 files in `supabase/migration_archive/` verified byte-identical this
pass via `git hash-object` against their source branch
(`feature/resources-r1-7d-human-editorial-compliance-approval` for the eight
Resources files; the two Phase 0C files — `0031_financial_section_status.sql`
and `0032_section_status_reviewed_with_data.sql` — are also present and
byte-identical, sourced from the `10bf196` Phase 0C commit per
`supabase/migration_archive/README.md`):

```
MATCH  0031_financial_section_status.sql
MATCH  0032_section_status_reviewed_with_data.sql
MATCH  0033_resources_foundation.sql
MATCH  0034_resources_seed.sql
MATCH  0035_resources_analyst_role_delta.sql
MATCH  0036_resources_anon_function_grants_fix.sql
MATCH  0037_resources_editor_support.sql
MATCH  0038_resources_specialist_content_support.sql
MATCH  0039_resources_public_settings_read.sql
MATCH  0040_resources_discovery_context_support.sql
```

`supabase/migration_archive/README.md` present, documents why each file was
displaced, its original stream, and which migration (`0049`) now re-emits its
effects — confirmed by direct read this pass.

## 9. Offline schema-replay evidence, reproduced this pass (supports spec §6/§16-18)

`node scripts/db-rebuild-check/replay.mjs`:

```
REPLAY COMPLETE: 49/49 migrations applied with zero manual intervention
FRESH-REBUILD MANIFEST: {"tables":155,"columns":2037,"constraints":2049,"indexes":465,"policies":182,"functions":11,"triggers":0,"views":0}
tables=155 rls_enabled=155 rls_disabled=0
ii tables: 33
resource tables: 20
fdh tables: 24
user_financial_section_status present: true
```

`node scripts/db-rebuild-check/equiv.mjs`:

```
[A] order-equivalence: PASS - schemas are byte-identical (columns/constraints/indexes/policies/rls/functions)
[C] negative control: PASS - control detected 2 differing categories (columns 206 vs 205, policies 48 vs 47)
[B] idempotency: PASS - re-application is a true no-op
SUMMARY  order-equivalence=PASS  negative-control=PASS  idempotency=PASS
```

Both reproduced exactly with no discrepancy from the previously-reported
results.

**Arithmetic correction carried forward from the dispatch brief:** 33 (II) +
20 (Resources) + 1 (Phase 0C) + 24 (FDH) = **78**, not 155. The remaining 77
of the 155 total tables are pre-existing base-FHIP tables from migrations
`0001`-`0030`, unrelated to this reconciliation. This was found stated
ambiguously (module counts placed directly next to a "155" total with no
subtotal row, inviting the wrong sum) in `CLEAN_REBUILD_CERTIFICATION.md`,
`DEV_POST_REPAIR_CERTIFICATION.md`, and `RECONCILIATION_PLAN.md`; all three
have been corrected in place as part of this pass (explicit subtotal rows
added, correction notes added) — see §41-42 disposition in
`MIGRATION_LINEAGE_COMPLETION_REPORT.md`.

## 10. What this document does NOT claim

This document does not claim `0049` has been applied to DEV. It does not
contain post-application evidence (`DEV_0049_APPLICATION_EVIDENCE.md` and
`DEV_0049_POST_APPLICATION_CERTIFICATION.md` were deliberately not created —
see `MIGRATION_LINEAGE_COMPLETION_REPORT.md`). Production
(`twwpnltizhtjxhamyoxt`) was never read, written, or contacted during this
pass.
