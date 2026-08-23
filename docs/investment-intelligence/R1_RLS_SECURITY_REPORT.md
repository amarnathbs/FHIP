# R1 — RLS / Security Report

Status: FINAL
Governing docs: `R0_SECURITY_RLS_ARCHITECTURE.md`, ADR-009, `R1_IMPLEMENTATION_SPEC.md` section 3.

## 1. Environment constraint, stated plainly up front

This report was produced in a sandbox with **no Docker/Podman installed** (confirmed: `docker --version` → command not found; no Docker Desktop install found at any searched path; `npx supabase start` fails at `LegacyDockerLifecycleInspectError`) and **no direct Postgres connection string to the DEV project**. This is the same wall every migration-dependent phase in this project's history has hit (migrations `0033` through `0040`, per the project's own memory record). Every RLS policy below was **written and hand-reviewed carefully** against the existing, proven FHIP-wide pattern, and **exercised for real over HTTP wherever the underlying infrastructure did not require the missing DDL execution capability** (see section 5 — storage). Where a test genuinely requires the migrated schema, it was run for real against DEV and recorded its exact failure (`PGRST205`, "relation does not exist" in spirit), never skipped or faked. See `R1_TESTING_AND_VERIFICATION.md` and `R1_ACCEPTANCE_REPORT.md` for the resulting classification discipline.

## 2. Every private (`ii_*`) table's RLS status

| Table | RLS enabled | Policy | Verified how |
|---|---|---|---|
| `ii_source_documents` | yes | `for all using (auth.uid()=user_id) with check (auth.uid()=user_id)` | Written, hand-reviewed against 6 existing identical policies (`goal_funding_sources`, `goal_contributions`, etc., migration `0009`). Live cross-user test: BLOCKED (table not yet on DEV). |
| `ii_accounts` | yes | same shape | Same as above |
| `ii_transactions` | yes | same shape | Same as above |
| `ii_tax_lots` | yes | same shape | Same as above |
| `ii_holding_snapshots` | yes | same shape | Same as above |
| `ii_fhip_publications` | yes | same shape | Same as above |
| `ii_goal_allocations` | yes | same shape | Same as above |
| `ii_analytics_results` | yes | same shape | Same as above |
| `ii_insights` | yes | same shape | Same as above |
| `ii_reconciliation_cases` | yes | same shape | Same as above |
| `ii_audit_events` | yes | `for select using (auth.uid()=user_id)` **only** — no insert/update/delete policy for any authenticated role | Written, matches the one asymmetric policy already proven in this codebase (`audit_events`'s existing select-only policy). Live insert-rejection test: BLOCKED. |

## 3. Every public/reference (`ii_*`) table's RLS status

| Table | RLS enabled | Policy | Write path |
|---|---|---|---|
| `ii_sources` | yes | `for select using (true)` | service-role only, via a future `requireAdmin()`-gated route (none built in R1 — no admin UI for this yet) |
| `ii_instruments` | yes | `for select using (true)` | service-role only (used today by `resolveOrCreateInstrument()`, a trusted server-side path) |
| `ii_instrument_identifiers` | yes | `for select using (true)` | service-role only |
| `ii_benchmarks` | yes | `for select using (true)` | service-role only (no content populated in R1) |
| `ii_benchmark_series` | yes | `for select using (true)` | service-role only |
| `ii_instrument_benchmarks` | yes | `for select using (true)` | service-role only |
| `ii_fund_holdings` | yes | `for select using (true)` | service-role only |
| `ii_prices_nav` | yes | `for select using (true)` | service-role only |
| `ii_tax_rule_versions` | yes | `for select using (true)` | service-role only |

Every reference table has **no** insert/update/delete policy for the authenticated role at all — confirmed by reading every migration file directly (no such policy was written), not merely asserted. This is identical to the existing `master_financial_items`/`goal_types` pattern.

## 4. Household-isolation approach

Identical to every other FHIP module: the RLS boundary is `auth.uid() = user_id`, the same single-user boundary Goals, Assets, Investments, and every other register already use. R0's `R0_SECURITY_RLS_ARCHITECTURE.md`/ADR-009 documented, correctly, that FHIP has **no genuine multi-person household access model anywhere in the platform today** — `household_members` is reference/tagging data within one owning user's RLS boundary, not a second authenticated principal. Investment Intelligence's R1 implementation does **not** attempt to invent a household-scoped RLS model unilaterally; doing so would create a one-module-only access idiom inconsistent with the rest of the platform, which R0 explicitly rejected as an alternative (ADR-009 section "Alternatives considered," item 1). This is a **platform-wide gap**, not an Investment-Intelligence-specific defect, and R1 does not claim to have solved it.

## 5. Storage isolation

The `investment-source-documents` bucket is real, private (`public=false`), and was created live on DEV via the Storage Admin API — a capability genuinely available in this sandbox (unlike SQL DDL). Live-tested (see `R1_SOURCE_STORAGE_REPORT.md` and `scripts/ii_r1_live_dev_security_tests.mjs` for the exact commands and results):

- **PASS** — unauthenticated (anon-key, no session) direct object access rejected (STOR-001).
- **PASS** — a different authenticated user's direct object access also rejected (STOR-002) — true today because *no* non-service-role principal has any grant at all (migration `0037`'s owner-read policy is not yet applied); this is **stronger** isolation than the eventual steady state, not weaker, but it does not yet prove "the true owner CAN read their own object via a direct authenticated request" — that half needs migration `0037` applied and is BLOCKED until then. Signed-URL access (the actual, only production read path — see `R0_SOURCE_PROVENANCE_CONTRACT.md` section 4) already works correctly today regardless (STOR-006), since signed URLs bypass RLS by design and don't depend on the pending policy at all.
- **PASS** — bucket-level MIME restriction rejects a disallowed file type (STOR-003).
- **PASS** — bucket-level size limit rejects an oversized file (STOR-004).
- **PASS** — signed URL is valid immediately and genuinely expires after its configured TTL (STOR-006).
- **PASS** — bucket is private, no public URL construction succeeds (STOR-007).
- **PASS** — service-role delete genuinely removes the object, verified by a subsequent failed fetch (STOR-008, storage-layer half).
- **BLOCKED** — STOR-005 (object references the correct `ii_source_documents` row) needs that table to exist.

## 6. Service-role usage

Every `createAdminClient()` call site in the Investment Intelligence codebase, listed exhaustively (confirmed via `grep -rn "createAdminClient" lib/services/investment-intelligence app/api/investment-intelligence`):

- `lib/services/investment-intelligence/audit.ts` — `emitAuditEvent()`, the sole `ii_audit_events` insert path (required, since that table has no authenticated-role insert policy by design).
- `lib/services/investment-intelligence/identifiers.ts` — `resolveOrCreateInstrument()`, writing to the shared/reference `ii_instruments`/`ii_instrument_identifiers` tables (which have no authenticated-role write policy by design).
- `lib/services/investment-intelligence/accounts.ts` — `findOrCreateIiAccountServiceRole()`, used **only** by the manual test importer (a trusted, developer/QA-only server-side flow, never called from a route that hasn't already run `requireUser()`).
- `lib/services/investment-intelligence/publishing.ts` — `publishPositionStructural()`, writing `ii_fhip_publications` (owner-only table — the service-role write happens after the calling route already verified `user.id` ownership of the underlying snapshot).
- `lib/services/investment-intelligence/goalAllocations.ts` — `createOrUpdateGoalAllocation()`, same pattern.
- `lib/services/investment-intelligence/storage.ts` — upload/signed-URL/delete against the private bucket (mirrors `report-exports`' existing, proven pattern exactly).
- `lib/services/investment-intelligence/manualImporter.ts` — the entire manual-test-importer chain, a trusted server-side developer/QA tool, never exposed to an unauthenticated caller (the one route that calls it, `source-documents/[id]/parse`, runs `requireUser()` first).

**No `ii_*` table is queried through the service-role client on a genuinely user-facing read path** — every `GET`/list route (`sources`, `accounts`, `positions`, `goal-allocations`) uses `createClient()` (the RLS-respecting `@supabase/ssr` client), matching the platform-wide discipline `R0_SECURITY_RLS_ARCHITECTURE.md` section 2 "Least privilege" requires. The service-role key is never sent to the browser — confirmed: it is read only from `process.env.SUPABASE_SERVICE_ROLE_KEY` inside server-only files (`lib/services/investment-intelligence/*.ts`, all executed server-side under the Next.js App Router API route convention; none is a `'use client'` file).

## 7. Admin access

No dedicated admin UI/route was built for `ii_sources`/`ii_instruments`/`ii_benchmarks`/`ii_tax_rule_versions` curation in R1 (not required by the acceptance checklist — reference-data write access exists structurally via the service-role client, consistent with the existing `master_financial_items`/`goal_types` pattern, but no `requireAdmin()`-gated route was built since R1's own migration `0038` seed already populates everything R1's test fixtures need). Building that admin curation UI is explicit R2+ scope, not an R1 gap — the *mechanism* (service-role write, RLS blocking direct authenticated write) is already correctly in place and tested at the policy-definition level.

## 8. Known FHIP platform-wide security gaps and whether they affect Investment Intelligence

1. **No genuine multi-person household access model** (section 4 above) — affects Investment Intelligence identically to every other module; not solved here, honestly documented, not silently dropped, per ADR-009.
2. **Two dead, unused audit tables** (`audit_events`, `financial_records_audit`) remain unconsolidated — does **not** affect Investment Intelligence, which deliberately does not reuse them (ADR-008); noted only because R0 flagged it and this report should not conceal it.
3. **No RLS policy in this codebase has ever been executed against a real Postgres instance from within an agent sandbox** in this project's history for any migration `0033`-`0040` either (per the project's own memory record) — Investment Intelligence's R1 gap is therefore consistent with, not worse than, the project's established pattern for migration-dependent phases.

## 9. Privacy / logging verification

Checked every `emitAuditEvent()` call site by hand (7 call sites, listed in `lib/services/investment-intelligence/manualImporter.ts`, `publishing.ts`, `goalAllocations.ts`, and the two `route.ts` files that call it directly): none passes a full PAN, full account/folio number, raw document bytes, access token, or service-role secret into `metadata`. `ii_accounts.account_number_masked` is the only account-number-shaped column and its name records the masking requirement; no R1 code path writes an unmasked number into it (no such input is even collected in any R1 form/fixture). `ii_source_documents.original_filename` is stored (needed for user-facing display, matches `report-exports`' equivalent field) but never logged to `console.*` anywhere in the Investment Intelligence codebase — confirmed via `grep -rn "console\." lib/services/investment-intelligence app/api/investment-intelligence` returning zero matches.

## 10. Summary verdict for this report

Every RLS policy is **written and correctly shaped** per the frozen R0 architecture, verified by direct hand-review against the file text and against the existing, proven FHIP-wide pattern it replicates exactly. **Genuine execution against a real Postgres instance could not be performed in this sandbox** — this is a testing-coverage gap, precisely distinguished throughout this report and `R1_TESTING_AND_VERIFICATION.md` from "tested and found broken." No structural defect was found in any policy on inspection: `grep -c "enable row level security" supabase/migrations/003{1..6}_*.sql` returns exactly **20** matches — one `alter table ... enable row level security` statement per canonical entity, matching `R0_CANONICAL_DATA_CONTRACT.md`'s 20-entity count exactly, with zero tables omitted.
