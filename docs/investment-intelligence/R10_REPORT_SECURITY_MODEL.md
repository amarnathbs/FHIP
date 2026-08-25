# II-R10 — Report Security Model

## 1. Finding: same-user authoritative-write forgery (CRITICAL, spec section 190(10))

**Status: FIXED IN CODE, PGlite-VERIFIED, NOT YET LIVE IN DEV** (no DDL
execution access this session — see `R10_ACCEPTANCE_REPORT.md`).

### Live reproduction (real DEV, this session, `scripts/r10_repro_reports_forgery.mjs` +
one isolated status-only variant)

One disposable test user was created via the admin API, signed in with a
real password (real JWT, `role: authenticated`, not anon/service-role), and
used to create one genuine owned report row exactly the way the app does.
Cleaned up (`admin.auth.admin.deleteUser`) immediately after. Results,
against the **unpatched** DEV schema (migration `0070` not yet applied
there):

| Attack | Target | Result |
|---|---|---|
| 1 | `reports.status`: `ready`→`published`, bypassing `publishReport()`'s guard entirely, plus forging `data_completeness_pct` | **FORGERY SUCCEEDED** (isolated status-only re-run, valid FK) |
| 2 | `report_sections.section_data_json`/`narrative_text` — the literal displayed financial numbers and narrative | **FORGERY SUCCEEDED** |
| 3 | `report_snapshots` — insert a fabricated provenance row (`source_version='forged-engine-9.9.9'`) | **FORGERY SUCCEEDED** |
| 4 | `report_exports` — insert `status='ready'` with an arbitrary `storage_path`, no PDF ever rendered | **FORGERY SUCCEEDED** |
| 5 | `report_generation_runs.output_status` — forge the generation audit trail itself | **FORGERY SUCCEEDED** |

5/5. Root cause: `supabase/migrations/0010_module9_reports.sql` (predates
Investment Intelligence entirely) gave every table in the reports family a
single `for all using (auth.uid() = user_id) with check (auth.uid() =
user_id)` policy — enforcing row ownership but not column/transition
authority. Same defect class as `ii_review_items` (fixed in `0069`),
`ii_tax_lots`/`ii_capital_gains_computations` (fixed in `0062`),
`fdh_statement_uploads.reconciliation_status` (fixed in `0065`).

Attack 4 chained with `app/api/report-exports/[exportId]/download/route.ts`
(which trusted `storage_path` straight off the row) meant a forged
`report_exports` row could sign a download URL for **any** storage path
string, including another user's real object path if one were ever
discovered by other means.

### Fix — `supabase/migrations/0070_ii_r10_reports_authoritative_write_hardening.sql`

Every legitimate write to this table family was confirmed (by grep across
`components/reports/**` and `app/(app)/reports/**`) to happen exclusively
server-side, never from the browser. The migration therefore drops the
single permissive policy on all six tables and replaces it with
**SELECT-own only** for the `authenticated` role — no insert/update/delete
policy at all, which Postgres RLS defaults to deny. Every write moved to the
service-role admin client in the same commit:

- `lib/services/reportsData.ts` — `generateReport()` now defaults to
  `createAdminClient()` instead of the per-request session client (the
  scheduled cron job already always did this); `publishReport()`,
  `archiveReport()`, `recordAccessEvent()` moved to a shared `writeClient()`
  helper (admin client).
- `app/api/reports/[id]/exports/route.ts` — initial `report_exports` insert
  moved to the admin client, with an explicit `.eq('user_id', user.id)`
  ownership check on `reports` first (replacing what the RLS `WITH CHECK`
  used to enforce).
- `app/api/reports/[id]/retry/route.ts` — the archive-old-failed-report
  update moved to the admin client.
- `app/api/report-exports/[exportId]/download/route.ts` — `download_count`
  increment and the `report_access_events` insert moved to the admin
  client.
- `app/api/report-exports/[exportId]/route.ts` — `DELETE` now confirms
  ownership on the RLS-scoped read, then deletes via the admin client.

Authorization for every server-side write is unchanged in substance: every
caller still derives `userId` from `requireUser()`'s validated session
before reaching these functions — only the *database-level* enforcement
moved from "RLS trusts the session's own JWT" to "the server already
checked, and now genuinely is the only thing that can write."

### PGlite certification (`scripts/r10_reports_rls_certification.mjs`, real Postgres 18 wasm, not simulated)

Run against a **fresh 70/70 migration replay from empty** (`scripts/db-rebuild-check/replay.mjs`
— 174 tables, 202 policies, `rls_enabled=174 rls_disabled=0`), then:

```
=== 1. READ REGRESSION CHECK ===        5/5 PASS (no read regression)
=== 2. SAME-USER FORGERY DENIAL ===     5/5 PASS (all 5 live-reproduced attacks now blocked, 0 rows affected each)
=== 3. CROSS-TENANT DENIAL ===          2/2 PASS (unchanged)
=== 4. TRUSTED SERVICE WRITES WORK ===  2/2 PASS (publish + export completion still succeed via service_role)
=== 5. NEGATIVE CONTROL ===             1/1 PASS (old policy shape reinstated on a scratch table
                                                    lets the identical forgery succeed again —
                                                    proves this suite is not vacuous)
RESULT: 15 PASS / 0 FAIL
```

The negative control is the important one: it demonstrates the test suite
itself is capable of catching the exact regression it just fixed, not just
asserting a tautology.

### What is genuinely NOT proven yet

- **Migration `0070` has not been applied to real DEV** — this agent has
  REST/data-plane access only (`SUPABASE_SERVICE_ROLE_KEY`), no DDL
  execution path (no `supabase db push`, no linked project, no DB
  connection string in this environment). The live reproduction above
  proves the defect was real; the PGlite certification proves the fix is
  correct; neither proves the fix is live. Per spec section 191, security
  cannot receive CONDITIONAL PASS — this is disclosed as an open FAIL item
  in `R10_ACCEPTANCE_REPORT.md`, not rounded up.
- Once `0070` is applied to DEV, re-running
  `scripts/r10_repro_reports_forgery.mjs` (idempotent — creates and cleans
  up its own disposable user each run) against live DEV should show 0/5
  attacks succeeding, which would close this item.

## 2. Everything else in scope 58/70-78/130-133/161-165 that was NOT independently re-verified this session

Cross-user isolation on the reports family (a completely different user
reading/downloading another user's report/PDF) was not separately
attack-tested this session — the existing `"own reports"`-style policies
were always row-scoped by `user_id`/`requested_by_user_id`, so the
cross-tenant read path was not suspected of being broken, and the PGlite
suite's section 3 (`CROSS-TENANT DENIAL`) does cover it structurally, but a
dedicated live-DEV two-real-user attack matrix (spec section 161, "Free User
A, Premium User B, Victim User C") was not run. Storage-object-level
cross-user access (spec section 162) inherits the `report-exports` bucket
policy from migration `0022`, unchanged by this session — not
independently re-attacked live. Premium-gate bypass (spec sections 58,
130, 163) was code-reviewed (`canExportReports()` gate in the exports
route is server-side and unaffected by this session's changes) but not
live-attack-tested this session.
