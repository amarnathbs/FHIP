# R4 — Security Verification

Covers spec sections 94-96. Rewritten during the R4 continuation pass
(2026-08-20), which was the first pass able to run security tests against
live DEV.

**Testing method.** Every result below was produced by
`scripts/ii_r4_live_dev_security_tests.mjs` executing real HTTP requests
against the DEV Supabase project `vqycarelcoijzwlpkpcz`, using two
genuinely separate authenticated users created through the Auth Admin API
and signed in for real access tokens. Code inspection was never accepted as
evidence. Anything that could not be genuinely evaluated is recorded
BLOCKED, never PASS.

**Result: PASS 26 · FAIL 4 · BLOCKED 7 (37 checks).** All four failures and
all seven blocks share a single root cause — migration 0043 sections 4-5
are not applied to DEV — described in §3.

## 1. Test users

| | |
| --- | --- |
| User A | `ii-r4-a-<stamp>@fhip-test.local` |
| User B | `ii-r4-b-<stamp>@fhip-test.local` |

Both are ephemeral, created at the start of the run and deleted in
teardown along with every seeded row. No production data is touched.

## 2. Results

### 2.1 Tenant isolation

| ID | Test | Result | Evidence |
| --- | --- | --- | --- |
| SEC-R4-003 | Unauthenticated (anon) read of analytics returns nothing | **PASS** | HTTP 200, 0 rows |
| SEC-R4-011 | User B cannot read user A's transactions or holding snapshots | **PASS** | tx=0, snap=0 |
| SEC-R4-001 | User B cannot read user A's analytics results | BLOCKED | see §3 |
| SEC-R4-002 | User A can read their own analytics results (positive control) | BLOCKED | see §3 |
| SEC-R4-012 | User B cannot insert analytics attributed to user A | BLOCKED | see §3 |

### 2.2 Reference-data write protection

This is the section spec section 96 makes an automatic FAIL condition if any
ordinary-user write succeeds. Every attempt was made as authenticated user
A with the anon apikey and A's real bearer token.

| ID | Table | Result | Evidence |
| --- | --- | --- | --- |
| SEC-R4-006 | `ii_prices_nav` | **PASS** | HTTP 403 `42501` RLS violation |
| SEC-R4-007 | `ii_benchmarks` | **PASS** | HTTP 403 `42501` RLS violation |
| SEC-R4-008 | `ii_benchmark_series` | **PASS** | HTTP 403 `42501` RLS violation |
| SEC-R4-009 | `ii_instrument_benchmarks` (insert) | **PASS** | HTTP 403 `42501` RLS violation |
| SEC-R4-009b | `ii_instrument_benchmarks` (alter existing mapping) | **PASS** | PATCH returned 204 but affected zero rows; re-read confirms `benchmark_id` unchanged |
| SEC-R4-010 | `ii_risk_free_rates` | BLOCKED | table does not exist in DEV |

SEC-R4-009b is worth noting: PostgREST returns 204 for a PATCH that RLS
filtered down to zero rows, so the status code alone would have been
misleading. The test therefore re-reads the mapping through the service
role and asserts the value is unchanged. A status-code-only assertion here
would have been a false pass.

### 2.3 Analytics-result integrity

| ID | Test | Result |
| --- | --- | --- |
| SEC-R4-ANALYTICS-WRITE | Ordinary user cannot forge an analytics row against the **live** schema | **FAIL** |
| SEC-R4-000/004/005 | Positive control, forged insert, forged update/delete (R4 shape) | BLOCKED |

## 3. Root cause: migration 0043 sections 4-5 are not applied

Verified live on 2026-08-20 by direct query:

* Sections 1-3 **are** applied — all 13 new columns confirmed present on
  `ii_prices_nav`, `ii_benchmarks`, `ii_benchmark_series` and
  `ii_instrument_benchmarks`.
* `ii_risk_free_rates` **does not exist** (`PGRST205`). Re-probed three
  times across the session, including after the PostgREST schema cache had
  demonstrably refreshed to pick up the 13 new columns — so this is a
  genuinely absent table, not a stale cache.
* `ii_analytics_results` **exists but is the wrong table.** It has the
  migration-0035 columns (`subject_type`, `subject_id`, `metric_value`,
  `calculation_version`, `input_snapshot`) and none of the R4 columns
  (`scope_type`, `data_as_of_date`, `input_snapshot_version`, …).

### 3.1 Why section 5 could never have applied

Migration 0035 ("R1 Migration E") already creates a table named
`ii_analytics_results` as a storage-shape placeholder. Migration 0043 as
originally written opened section 5 with a bare
`create table ii_analytics_results (...)`, which fails with *relation
already exists* — and therefore never reaches the hardened RLS policy it
was supposed to install. The migration had never been run against a real
database, so this was not previously detectable.

### 3.2 The resulting live security gap

The 0035 placeholder's policy is:

```sql
create policy "own ii_analytics_results" on ii_analytics_results
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

`for all` grants INSERT/UPDATE/DELETE to the authenticated role. This was
confirmed by direct exploitation, not inferred:

```
>>> Ordinary user INSERT into live ii_analytics_results: HTTP 201
    [{"id":"844fbefd-…","user_id":"1536532a-…","subject_type":"portfolio",
      "metric_key":"portfolio_twrr","metric_value":9.999999,
      "calculation_version":"FORGED-BY-CLIENT",…}]
    RESULT: *** SECURITY GAP *** — an ordinary user CAN write analytics rows
```

(The forged row was deleted immediately; the probe is
`scripts/ii_r4_analytics_rls_probe.mjs`.)

This violates the spec section 95 requirement that fake-analytics
insertion be rejected at the database layer.

**Scope of the exposure, stated precisely.** This is a pre-existing R1
condition, not something R4 introduced, and its blast radius today is
limited:

* No R4 code path reads `ii_analytics_results` back. The GET route
  recomputes from source data on every request, so a forged row cannot
  currently alter a number shown to any user, including the forger.
* Nothing in R1-R3 reads the table either — R0/R1 explicitly shipped it as
  "storage shape only", with no engine attached.
* A user can only write rows where `user_id = auth.uid()`; cross-user
  forgery is still blocked by the `with check` clause (SEC-R4-012 would
  confirm this once the table has the R4 shape).

It is nonetheless a real failure against an explicit R4 requirement, and
R4 must not be certified UNCONDITIONAL while it stands.

### 3.3 Fix applied to the migration

`supabase/migrations/0043_…sql` has been corrected in this pass:

1. **Made fully idempotent** — every statement is now guarded
   (`add column if not exists`, `create table if not exists`,
   `create index if not exists`, `drop policy if exists`, and
   `pg_constraint` existence checks around the two `add constraint`
   statements). The whole file can safely be re-run end to end; the
   already-applied sections 1-3 will be skipped.
2. **Section 5 now handles the collision non-destructively** — the legacy
   table is renamed to `ii_analytics_results_r1_legacy` (preserving any
   rows rather than dropping them), its permissive `for all` policy is
   dropped and replaced with a SELECT-only policy so the legacy name is not
   left as a write back-door, and the R4 table is then created under the
   canonical name with its intended SELECT-only policy.
3. Defensive `drop policy if exists "own ii_analytics_results"` before
   creating the R4 policy, so no permissive policy of any vintage can
   survive on that name.

**This fix is written but NOT applied.** This session has no DDL
capability: PostgREST does not execute DDL, and no `exec_sql`-style RPC
exists on the project (probed five candidate names, all `PGRST202`). The
Product Owner must re-run the corrected migration.

## 4. Re-verification procedure after the migration is applied

```
node scripts/ii_r4_schema_probe.mjs           # expect: MIGRATION 0043 FULLY APPLIED: YES
node scripts/ii_r4_live_dev_security_tests.mjs # expect: FAIL=0, BLOCKED=0
```

The security harness needs no edits — the blocked tests are already
written and will evaluate for real as soon as the schema exists. Expected
transitions:

| ID | Now | After |
| --- | --- | --- |
| SCHEMA-GATE / SCHEMA-RF / SCHEMA-ANALYTICS | FAIL | PASS |
| SEC-R4-ANALYTICS-WRITE | FAIL | PASS (403 RLS) |
| SEC-R4-000/001/002/004/005/012 | BLOCKED | PASS |
| SEC-R4-010 | BLOCKED | PASS |

## 5. Application-layer security properties (static, and true today)

These do not depend on the migration:

* **No spoofable identifier exists.** Neither analytics route accepts a
  household, account, instrument or benchmark id. `GET` accepts only
  `from`/`to` date bounds, validated against `^\d{4}-\d{2}-\d{2}$` with an
  inverted-range check; `POST /recalculate` accepts no input at all and
  ignores any request body. Scope is resolved exclusively from
  `requireUser()`.
* **Reads go through the RLS-respecting request client**, so a filter bug
  cannot cross a tenant boundary.
* **Writes are confined to `ii_analytics_results`** and use the
  service-role client, with `user_id` overwritten server-side on every row.
* **No financial register is writable from R4.** Static grep over every
  file added in this pass finds exactly one DB mutation — the
  `ii_analytics_results` upsert. See `R4_API_AND_UX_ARCHITECTURE.md` §9.
