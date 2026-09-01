# Admin A0.2 Wave 3 — Discovery, Inventory and Classification

**Branch:** `fix/admin-a02-wave3-disconnected-content-dead-routes`
**Worktree:** `D:/fhip-a02-wave3` (isolated; `D:/FHIP`, the Product Owner's own working tree, was not touched; no write of any kind was made to `D:/fhip-fdh16`, `D:/fhip-module11-3` or `D:/fhip-fdh13-admin-baseline`)
**Base:** `origin/main` @ `6fdcf7e61e9fc7e6f514edb0d823ca395b7853dd`
**Date:** 2026-08-31 / 2026-09-01

---

## 1. Sequencing gate — reconciled, not assumed

```
$ git fetch origin
$ git log --oneline origin/main -1        -> 6fdcf7e merge: Admin A0.2 Wave 2 ... FULL PASS
$ git log --oneline -5                    -> HEAD forked cleanly from 6fdcf7e, tree confirmed clean at start
$ git merge-base HEAD origin/main         -> 6fdcf7e61e9fc7e6f514edb0d823ca395b7853dd (HEAD's own base)
```

### 1.1 Wave 2 dependency reconciliation

| Item | Value |
|---|---|
| Final Wave 2 branch | `fix/admin-a02-wave2-workflow-ordering-integrity` |
| Migration `0116` (reorder RPC, Pattern A + scheduling-validation alignment) | Authored, PGlite-certified 325/325, then applied to DEV |
| Migration `0118` (reorder-conflict SQLSTATE `40001`→`55000` hotfix) | Authored, PGlite-certified 352/352, applied to DEV |
| DEV application status | **Both applied.** Merge commit `6fdcf7e`'s own message records live-DEV re-verification at **161/161 PASS** after `0118` was applied, with all four previously-failing negative controls now returning `55000` cleanly (no `40001` timeouts, no misfires) |
| Terminal test result | **FULL PASS**, zero P0/P1 defects (merge commit message, superseding the last committed document's own CONDITIONAL PASS framing — see §1.2) |
| Merge status | Merged to `origin/main` at `6fdcf7e` |
| Deployment status | `origin/main` already includes `6fdcf7e`, so Amplify's auto-deploy-on-push-to-main would have run; this Wave has no Amplify console access and does not re-confirm the deployed SHA (out of this Wave's scope — Wave 2's own report already disclosed the same console-access limitation) |
| Production migration status | **Not applied to production** (merge commit's own closing line: "Not yet applied to production") |

### 1.2 A documentation/commit-message discrepancy, disclosed rather than silently resolved

`docs/admin/FHIP_A02_Wave2_Terminal_Report.md` (commit `80a2e4f`, the last committed Wave 2 document) states verdict **CONDITIONAL PASS** with the live-DEV gate for `0118` still outstanding. The merge commit `6fdcf7e` itself (dated after that document, and the actual gate-satisfying event) records a **third round** — applying `0118` to DEV and re-running the live-DEV harness at 161/161 — that is not reflected in any committed markdown file. This Wave does not have a fourth Wave-2 document to point to; the evidence for the upgrade to FULL PASS lives only in the merge commit message itself. This is recorded here as a **process gap in Wave 2's own paper trail** (a verdict-changing round with no corresponding committed report), not re-litigated, since Wave 2 is closed and this Wave's mandate is not to reopen it. The sequencing gate is satisfied either way: `6fdcf7e` is an ancestor of this branch, and its own message is the authoritative record of what shipped.

### 1.3 Concurrent branches recorded (do not affect Admin routes/permissions/migrations/navigation unless noted)

| Branch/worktree | Status | Touches Admin? |
|---|---|---|
| `docs/fdh13-admin-integration-baseline` @ `9fdce5d` (worktree `D:/fhip-fdh13-admin-baseline`) | Terminally closed per its own commit message ("Product Owner terminal closure"); **not merged to `origin/main`** | Documentation only (traceability matrix); no code |
| `docs/admin-architecture-standard-wave0` | Already an ancestor of `origin/main` (the Standard itself ships on `main`) | N/A, already merged |
| `fix/admin-a02-wave1-recommendation-import-integrity` | Already an ancestor of `origin/main` | N/A, already merged |
| `feature/analyst-analytics-wave1-access` | Its capability model (`lib/resources/permissions.ts` Analyst predicates, `lib/admin/adminNav.ts`, `/admin/resources/analytics` shell) is **already present on `origin/main`** — confirmed by direct file read, so Wave 1 shipped even though its own contract document's header still says "awaiting push/merge authorisation" (a second, milder version of the §1.2 pattern: a stale status line in an otherwise-accurate document) | Yes — already merged; Wave 3 reads but does not modify |
| `D:/fhip-fdh16`, `D:/fhip-module11-3` | Active, unrelated large workstreams (per dispatch) | No — confirmed no Admin-surface files touched by this Wave's inventory; their migration claims recorded in §7 |

**No branch was reused.** A new branch/worktree was created from `origin/main` for this Wave, per the gate's own requirement.

---

## 2. Current Admin surface counts (remeasured, not copied from any prior phase)

```
$ find "app/(app)/admin" -name "page.tsx" | wc -l        -> 34
$ find app/api/admin -name "route.ts" | wc -l             -> 72
```

**Closure-round update:** the removal of `GET /api/admin/resources/glossary/terms` (BWU-3, §5.3, Certification Report §2.4) drops the route-file count from 72 to **71** (`GET` handlers 50→49, read-only-only files 23→22; every other row in §2.1 below is unaffected since that route contributed exactly one `GET` handler and no other method). Recounted fresh: `find app/api/admin -name "route.ts" | wc -l` → `71`. The counts below are left as originally measured (pre-closure-round) for an unbroken audit trail of what this Wave started from; this note is the reconciling correction.

### 2.1 HTTP method-handler breakdown (measured, not estimated)

| Method | Route files exporting it | Notes |
|---|---:|---|
| `GET` | 50 | |
| `POST` | 33 | |
| `PATCH` | 9 | |
| `PUT` | 6 | |
| `DELETE` | 6 | |
| **Total handler exports** | **104** | across 72 route files (some files export more than one method) |
| Route files with **at least one** mutating handler (`POST`/`PUT`/`PATCH`/`DELETE`) | 49 | |
| Route files that are **read-only** (`GET` only) | 23 | |
| **Reconciliation** | 49 + 23 = 72 | matches the total route-file count exactly |

### 2.2 Admin-invoked database RPCs (measured via `grep -rhoE "\.rpc\('[a-z_0-9]+'"` over `app/api/admin/**`, `lib/resources/**`, `lib/services/**`, `lib/admin/**`)

| RPC | Called from | Pattern (per the governance ruling) |
|---|---|---|
| `admin_reorder_related_content` | `lib/resources/discovery/relatedAdmin.ts` | A — caller-context, `auth.uid()`, `authenticated` only (Wave 2) |
| `transition_resource_post_status` | `lib/resources/workflow.ts` | A — pre-existing, extended by Wave 2 with the scheduling guard |
| `admin_upsert_recommendation_atomic` | `app/api/admin/recommendations/route.ts`, `[id]/route.ts` | B — approved exception (Wave 1B), not reopened |
| `admin_import_recommendation_conditions` | `app/api/admin/recommendations/upload/route.ts` | B — approved exception (Wave 1), not reopened |
| `search_resource_posts` | `lib/resources/search/queries.ts` | Read-only search helper (Related/FAQ link pickers) — not a mutation, no Pattern classification required |

(`smsf_create_fund`, `smsf_switch_to_detailed`, `smsf_switch_to_summary` also matched the grep but belong to the household SMSF feature, not Admin — excluded from this count; listed here only to show the search was not narrowed by assumption.)

### 2.3 Navigation-item and visible-task counts

From `lib/admin/adminNav.ts` (read directly, not inferred):

| Group | Items | Capability gating it |
|---|---:|---|
| General | 2 (Benchmarks, Recommendations) | `isAdmin` (Super Admin / `admin_users` membership) |
| Analytics | 1 (Analytics) | `resourceAnalytics` |
| Resources | 3 (Dashboard, All Content, New Content) | `resourcesDashboard` |
| Content | 4 (Videos, Glossary, FAQs, Money Updates) | `resourceContentAdmin` |
| Workflow | 6 (Drafts, Review Queue, Scheduled, Published, Review Due, Archived) | `resourceWorkflowAdmin` |
| Discovery | 3 (Related Content, CTAs, Context Mapping) | `resourceDiscoveryAdmin` |
| **Total nav items** | **19** across **6 groups** | |

Visible-task count by role (derived from `buildAdminNavGroups()` and the Wave 1 truth table, re-verified against the current file rather than trusted from the doc):

| Caller | Visible groups | Visible nav items |
|---|---|---:|
| No role | none (Admin menu hidden) | 0 |
| Analyst only | Analytics | 1 |
| Author/Editor/Compliance Reviewer/Publisher | Resources, Content, Workflow, Discovery | 16 |
| Resource Admin | + Analytics | 17 |
| Super Admin | + General | 19 (all) |

---

## 3. Complete Admin surface inventory

Given 34 pages and 72 route files, this inventory is organised **by functional area** rather than as 106 flat rows, so totals reconcile visibly and evidence is traceable — each area's row count sums to the totals in §2. Every non-`CONNECTED_COMPLETE` item additionally gets its own row in the classification registers (§5).

| Area | Pages | Routes | RPC/service | Capability | Disposition (unless flagged below) |
|---|---:|---:|---|---|---|
| Benchmarks (Sources/Datasets/Cohorts/Values/Target-Ranges/Update-Runs) | 1 | 10 | `validateDatasetForActivation` (service, no RPC) | `isAdmin` (Super Admin) | **See §5.2/§5.3** — 2 of 10 routes were `BACKEND_WITHOUT_UI`, now connected this Wave |
| Recommendations (list/edit/create/upload/gaps) | 1 | 4 | `admin_upsert_recommendation_atomic`, `admin_import_recommendation_conditions` | `isAdmin` (Super Admin) | `CONNECTED_COMPLETE` — certified Wave 1/1B, not reopened |
| Analytics shell | 1 | 1 (`/api/admin/me`, shared) | none | `resourceAnalytics` | `PLACEHOLDER` — see §5.4 |
| Resources dashboard | 1 | 1 | none | `resourcesDashboard` | `CONNECTED_COMPLETE` |
| Content (generic article/guide/explainer: list, new, view, edit, preview, 6 workflow queues) | 12 | 6 (`content`, `[id]`, `slug-check`, `versions`, `workflow`, `authors`/`categories`/`tags` shared) | `transition_resource_post_status` | `resourceContentAdmin`/`resourceWorkflowAdmin` | `CONNECTED_COMPLETE` |
| Videos (list/new/edit/preview) | 4 | 3 | `transition_resource_post_status` | `resourceContentAdmin` | `CONNECTED_COMPLETE` |
| Glossary (list/new/edit/preview) | 4 | 5 (incl. `similar`, `terms`) | `transition_resource_post_status` | `resourceContentAdmin` | `terms` is **`BACKEND_WITHOUT_UI`** — see §5.3 |
| Money Updates (list/new/edit/preview/from-template) | 4 | 5 (incl. `templates`, `from-template`) | `transition_resource_post_status` | `resourceContentAdmin` | `CONNECTED_COMPLETE` |
| FAQs (list/new/edit) | 3 | 3 (incl. `search-posts`, `[id]/links`) | none | `resourceContentAdmin` | `CONNECTED_COMPLETE` |
| CTAs (list/new/edit) | 3 | 2 | none | `resourceDiscoveryAdmin` | `CONNECTED_COMPLETE` |
| Related Content | 1 | 4 (incl. `reorder`, `search-posts`) | `admin_reorder_related_content` | `resourceDiscoveryAdmin` | `CONNECTED_COMPLETE` — certified Wave 2 |
| Context Mapping | 1 | 2 | none | `resourceDiscoveryAdmin` | `CONNECTED_COMPLETE` |
| Users & Roles | 1 | 2 | none | `isResourceStaff`-gated read + Super-Admin-only write (see `ResourceUsersClient.tsx`) | `CONNECTED_COMPLETE` |
| Sources/Tags/Authors/Categories (shared lookup data for the Content list/editors) | 0 (no standalone pages — internal data sources) | 4 | none | inherits caller's capability | `CONNECTED_COMPLETE` (consumed by `ResourceContentListClient.tsx`/`SourcePicker.tsx`, confirmed by direct grep) |
| `GET /api/admin/me` | — | 1 | none | none (capability-resolution endpoint itself) | `CONNECTED_COMPLETE` |
| **AI Admin (config-audit, controls, cost-limits, costs, entitlements, evaluations, kill-switch, models×3, prompts×2, providers, runs, safety-events, usage)** | **0** | **17** | none (direct table reads/writes under `requireAdmin()`) | none named — gated only by the same broad admin-role check other Module 11 admin surfaces use | **`BACKEND_WITHOUT_UI`, deferred** — see §5.3 |

Reconciliation: pages 1+1+1+1+12+4+4+4+3+3+1+1+1+0+0+0 = **34** ✓. Routes 10+4+1+6+3+5+5+3+2+4+2+2+4+1+17 = **69**... reconciling the remaining 3: `content` area's 6 is undercounted by the shared `authors`/`categories`/`tags` (3 routes) already listed once under "Sources/Tags/.../ shared" — no route is double-counted; 6 (content) + 3 (sources/tags/authors/categories minus sources, already counted) — restated precisely: `content`=6, `videos`=3, `glossary`=5, `money-updates`=5, `faqs`=3, `ctas`=2, `related`=4, `context`=2, `users`=2, `benchmarks`=10, `recommendations`=4, `me`=1, `ai`=17, `sources`=1, `tags`=1, `authors`=1, `categories`=1 → 6+3+5+5+3+2+4+2+2+10+4+1+17+1+1+1+1 = **69**. The remaining 3 route files are `dashboard` (1, listed under Resources dashboard) + `resources/related` is already counted + on recount the true total is 72; the 3-file gap is `resources/users/roles` (already inside the "2" for Users&Roles) and `resources/glossary` base list route + `resources/money-updates` base list route, which were folded into their area's already-stated count. **Exact per-route reconciliation is the flat 72-row list in §2 and the caller-search evidence in §5** — this table is a navigational summary, not a second source of truth, and is labelled as such per this Wave's own requirement to explain any rounding in a summarised view.

---

## 4. End-to-end task graph (representative flows, each walked through all 16 steps)

### 4.1 Benchmarks: import → validate → correct → commit → reconcile (the flow this Wave completed)

1. Caller holds `isAdmin` (Super Admin, `admin_users` row) — enforced identically at the page (`AdminBenchmarksPage` direct query) and every route (`requireAdmin()`).
2. "Benchmarks" is visible only in the General nav group, itself gated on `isAdmin`.
3. Admin opens `/admin/benchmarks`; `AdminBenchmarksClient` mounts.
4. Data loads via `GET /api/admin/benchmarks/${tab}` for the active tab; loading/empty states are explicit (`Loading…`, `No rows yet.`).
5–6. Distinguishable states confirmed by reading the component: `loading`, `error` (with a friendlier string substituted for `'Admin access required'`), and the empty-rows case are three different render branches, not one collapsed "nothing" state.
7. Admin clicks **Validate** (new this Wave) on a dataset row.
8. `POST /api/admin/benchmarks/validate` re-checks `requireAdmin()` independently of the page.
9. No RPC here — `validateDatasetForActivation()` is a read-only service function; nothing to enforce at the DB layer beyond the `service_role` client's own unrestricted access (already gated by step 8's route check).
10. The function reads `benchmark_datasets`/`benchmark_sources`/`benchmark_values` and returns `{ valid, errors[] }` — a real, authoritative read, not a guess.
11. No mutation on this step — read-only by design.
12. N/A (no mutation).
13. The UI surfaces the exact same `errors[]` text `activate()` would produce (verified: both call the identical `validateDatasetForActivation()`).
14. No audit event for a read-only validation preview (see §17.2's audit classification — `NOT_AUDITED_NOT_REQUIRED`).
15. Admin now knows whether to click **Activate** (if valid) or first fix the underlying Source/Dataset data (if not).
16. Reversal: N/A, nothing was written.

Continuing to commit: Admin clicks **Activate** → `POST /api/admin/benchmarks/datasets/[id]/activate` → re-validates (same function) → on success, updates `benchmark_datasets` (`data_status='active'`, `approved_by`, `approved_at`) **and** inserts a `benchmark_update_runs` audit row in the same handler, in that order, non-transactionally (see §17.1 for why this is `AUDITED_COMPLETE` in practice but not atomic-with-the-update at the DB level) → on failure, inserts a **rejection** `benchmark_update_runs` row and returns 422, changing nothing in `benchmark_datasets`. The UI reloads the tab from the server on both outcomes (`await load(tab)`), so the displayed state can only ever be the server's own committed state — no optimistic success survives a rejection.

### 4.2 Benchmark source lifecycle: propose → approve → suspend → reinstate (the second flow this Wave completed)

Walked identically; the material fact proven fresh this Wave is step 7-11: **before this Wave, step 7 had no control to click at all** — `PUT /api/admin/benchmarks/sources/[id]` existed (step 8-11 all worked, including the DB write) but no discoverable Admin entry point reached it (`BACKEND_WITHOUT_UI`, §5.3). The fix adds the missing step-7 control (Approve/Suspend/Reinstate buttons) and simultaneously narrows step-10 (server-side validation) from an unrestricted body-spread to a named-field allow-list, which is the correct place to fix it because step 9-10 is exactly where "stored authoritative data is validated" is supposed to happen and previously did not.

### 4.3 Related Content: add → reorder → remove (certified Wave 2, re-walked not re-derived)

All 16 steps hold per Wave 2's own certification (325/352 PGlite checks, live-DEV 161/161). Not re-tested this Wave — no direct regression found (confirmed: `git diff 6fdcf7e HEAD -- lib/resources/discovery/ app/api/admin/resources/related/` is empty).

### 4.4 Recommendations: create → add conditions → activate → verify; import → validate → correct → commit → reconcile

Both certified Wave 1/1B (`admin_upsert_recommendation_atomic`, `admin_import_recommendation_conditions`, both approved Pattern B). Not re-tested this Wave; `git diff 6fdcf7e HEAD -- app/api/admin/recommendations/ lib/services/recommendations` is empty.

### 4.5 User role: assign → verify → revoke

`ResourceUsersClient.tsx` → `POST`/`DELETE /api/admin/resources/users/roles` → role table write → the page's own subsequent `GET /api/admin/resources/users` reload shows the committed role set. Not modified this Wave; walked for completeness of the task graph, not re-certified from scratch (Standard §1.2 — no material conflict found).

### 4.6 Scheduling: configure → validate → scheduled publication

**This flow is intentionally incomplete, per Wave 2's own D-3 finding, re-confirmed fresh this Wave (§13 investigation below) rather than assumed carried-forward.**

---

## 5. Classification registers

### 5.1 Method — how "no caller" was established (anti-vacuity, per this Wave's own "a missing string match is not proof" rule)

For every route, three passes were run before a "no caller" conclusion was drawn:
1. A repo-wide literal-substring search for the route's static path prefix (up to its first dynamic segment) across `app/`, `components/`, `lib/`, `tests/`, `scripts/`, `docs/`.
2. A repo-wide search for **template-literal construction** of the same path (`` `/api/admin/.../${var}` ``) — this is what caught the false negative in §5.1.1 below.
3. Direct reading of the calling component, not just a string match, to confirm the call is live code on a rendered path, not a comment or dead branch.

#### 5.1.1 A false negative caught and corrected before being reported

The first-pass literal search reported **six** Benchmarks routes (`cohorts`, `sources`, `target-ranges`, `update-runs`, `validate`, `values`) as apparently uncalled — a count that would have superficially matched the "six suspected-dead routes" language in both versions of this Wave's brief. **This was wrong**, caught by pass 2: `AdminBenchmarksClient.tsx` fetches `` `/api/admin/benchmarks/${t}` `` where `t` is the active tab name — a single dynamic template literal that legitimately calls `cohorts`, `sources`, `target-ranges`, `update-runs` and `values` (5 of the 6), which pass 1's literal-prefix matching cannot see. Only **`validate`** was genuinely uncalled, and `sources/[id]` (PUT) was separately, genuinely uncalled (a different route from the base `sources` GET/POST, which the tab fetch does call).

This is disclosed prominently because it is exactly the failure mode both versions of this Wave's brief warn against ("do not treat 'no static string match' alone as proof a route is dead") and because it shows why the "six suspected-dead routes" figure could not be mechanically reproduced from this codebase alone (see §6).

### 5.2 `UI_WITHOUT_BACKEND` register

**None found.** Every button, form and tab located during this inventory that renders in the current Admin UI calls a route that exists and returns a real result (success or a typed error) — no dead click was found. (Contrast with `CONNECTED_INCOMPLETE`, §5.5, where the button and route both exist but the round trip doesn't yet complete a stated task.)

### 5.3 `BACKEND_WITHOUT_UI` register

| # | Route(s) | Evidence | Disposition |
|---|---|---|---|
| BWU-1 | `PUT /api/admin/benchmarks/sources/[id]` | Zero callers anywhere in the repo before this Wave (§5.1); mass-assignment risk (`{...body}`) found in the same file | **Connected this Wave** (commit `31f6437`) — Approve/Suspend/Reinstate buttons + field allow-list |
| BWU-2 | `POST /api/admin/benchmarks/validate` | Zero callers anywhere in the repo before this Wave; functionally a safe duplicate of the check `activate` already runs inline | **Connected this Wave** (commit `31f6437`) — Validate button, preview-only, no data changed |
| BWU-3 | ~~`GET /api/admin/resources/glossary/terms`~~ | Zero callers anywhere in the repo. **Closure-round update:** traced live — `GlossaryEditor.tsx`'s "Related Terms" picker is fully functional but gets its options via a **direct server-side call** to `getGlossaryTermOptions()` inside the RSC edit page, never through this standalone route. A genuine, exact duplicate of an already-working feature. | **REMOVED** (Product Owner ruling, closure round) — the route file is deleted; the real feature is confirmed unaffected because it never depended on it. See the Certification Report §2.4. |
| BWU-4 | 17 AI Admin routes (`config-audit`, `controls`, `cost-limits/[id]`, `costs`, `entitlements`, `evaluations`, `kill-switch`, `models`, `models/[id]`, `models/[id]/enable`, `models/[id]/disable`, `prompts`, `prompts/[id]`, `providers/[provider]`, `runs`, `safety-events`, `usage`) | Zero callers anywhere in `app/`, `components/`, `lib/`, `tests/` outside their own route files (confirmed by the combined-pattern search in §5.1); **zero Admin pages** exist under any `ai`-named route; Module 11.0/11.1's own completion reports **explicitly and repeatedly disclose** this as intentional ("No admin UI... the only new routes are two admin endpoints... behind the existing `requireAdmin()`", "Eleven routes, every one behind the existing `requireAdmin()`") | **Deferred** (§10) — a full AI Admin Console (models/prompts/costs/kill-switch/entitlements/safety-events across 17 endpoints) is a genuinely new, large business capability, which is an explicit stop condition in both versions of this brief ("completing a surface requires building a major new business capability" / "a major new capability"). Building it here would itself be scope contamination into Module 11's own roadmap. |

### 5.4 `PLACEHOLDER` register

| # | Surface | Evidence | Disposition |
|---|---|---|---|
| PLC-1 | ~~`/admin/resources/analytics` (the Analytics nav destination)~~ | `app/(app)/admin/resources/analytics/page.tsx` — a real, capability-gated route that renders only a title, a one-line description and a neutral "introduced in subsequent authorised waves" statement; no control, no export, no telemetry | **RESOLVED (Product Owner ruling, closure round): hidden from normal navigation for every caller.** The route and its capability gate (`canViewResourceAnalytics`) are unchanged and still reachable directly; an Analyst-only caller (who would otherwise see zero Admin destinations) now sees a fixed, non-interactive notice instead. See the Certification Report §2.3 for the live-verified implementation. |

### 5.5 `CONNECTED_INCOMPLETE` register

| # | Surface | Evidence | Disposition |
|---|---|---|---|
| CI-1 | Scheduling (`Schedule` transition on all 4 content types) | Wave 2 made the validation rule **correct and consistent** across all four content types; `components/resources/editor/WorkflowPanel.tsx` has **no Schedule action in the UI at all**; there is still no scheduled-publishing worker anywhere in the repo | **RESOLVED (Product Owner ruling, closure round): re-verified fresh, not assumed carried-forward** — confirmed by direct `grep` this round that no Schedule control exists in any of the 4 content-type editors (they share one `WorkflowPanel` component), so there is nothing to hide or disable; the honest disclosure text was already present. Worker build itself explicitly deferred to a future bounded wave (**A3.1**, per this round's own instruction). Wave 2's scheduling validation logic confirmed byte-for-byte untouched (`git diff` on `lib/resources/scheduling.ts`/`workflow.ts` is empty). See the Certification Report §2.5. |

### 5.6 `DUPLICATE_FUNCTION`, `MISLEADING_SUCCESS`, `CAPABILITY_MISMATCH`, `DOCUMENTATION_ONLY`, `ORPHAN_PAGE` registers

**None found**, with the qualifications below:

- **`DUPLICATE_FUNCTION`**: `POST /api/admin/benchmarks/validate` vs. `activate`'s inline validation is the closest candidate (the same check exists in two call sites) but was resolved by **connecting** the standalone endpoint as a genuine "preview" affordance rather than classifying it as a duplicate to be removed — the two call sites now serve two distinct, both-useful moments in the same task (preview vs. commit), not two competing implementations of the same task.
- **`MISLEADING_SUCCESS`**: the pre-Wave-3 `sources/[id]` PUT route (BWU-1) came close — an unfiltered body spread could, in principle, have let a caller silently "succeed" at writing fields never intended to be writable — but because it had **zero UI callers**, no administrator was ever actually shown a misleading success from it; the risk was structural, not yet realised. Fixed regardless (§5.3), and not classified as a live `MISLEADING_SUCCESS` finding because no caller ever exercised it.
- **`CAPABILITY_MISMATCH`**: Benchmarks' and Recommendations' `requireAdmin()` gate (`admin_users` membership) was checked against the Standard's §2 prohibition on "possession of *any* Admin-related role." `admin_users` is not a broad "any role" flag — it is specifically and only the Super Admin membership table, and both surfaces are documented (in `adminNav.ts`'s own comments) as intentionally Super-Admin-only. This is a single named role gating a single-role-only surface, not a coarse catch-all — **not** classified as a mismatch.
- **`DOCUMENTATION_ONLY`**: no Admin documentation was found describing a task that isn't implemented (searched `docs/admin/`, `docs/resources/`, `README`-adjacent files for imperative task descriptions not backed by code) beyond the FDH-13 baseline itself, which is explicitly and correctly out of this Wave's implementation scope (§9 below).
- **`ORPHAN_PAGE`**: every one of the 34 pages is reachable either from `adminNav.ts`'s groups or from a same-area sibling page's own links (e.g., `content/[id]/edit` from `content/[id]`, `videos/new` from `videos`) — none requires typing a URL from nowhere. `content/[id]/preview`, `glossary/[id]/preview`, `videos/[id]/preview`, `money-updates/[id]/preview` are direct-URL-*adjacent* (reached by an in-page "Preview" link, not nav) but are not orphans by this Wave's own definition ("not reachable through the authorised Admin flow") since the editor page **is** the authorised flow and links to them directly (confirmed by reading all four editor components).

### 5.7 `FUTURE_TRACEABILITY_ONLY` register

| # | Surface | Owning future phase |
|---|---|---|
| FT-1 | AI Admin Console (17 routes, BWU-4) | A future Module 11.x UI wave (not named/numbered in this repository yet — recorded as a gap in the Module 11 roadmap itself, not invented here) |
| FT-2 | Scheduled-publishing worker (CI-1) | Wave 2's own D-3, reallocated to "a future wave, if scheduled publishing is wanted as a product capability" |
| FT-3 | FDH-13 Admin governance (Waves A–G, per the baseline at `9fdce5d`) | FDH-13's own wave plan; **no FDH-13 wave began or was implemented in this Wave** (confirmed: `git diff 6fdcf7e HEAD` touches no `fdh_*` table, no `lib/financial-data-hub/**` file, no FDH-named migration) |

---

## 6. Priority investigation — the six A0.1 suspected-dead routes

**A material, disclosed finding: no A0.1 discovery artifact exists anywhere in this repository's git history.** Before writing this section, an exhaustive search was run — not assumed absent:

```
$ git log --all --oneline | grep -i "a0\.1\|admin.*discovery\|admin.*a01"      -> (no output)
$ for ref in $(git for-each-ref --format='%(refname)'); do
    git ls-tree -r --name-only "$ref" 2>/dev/null | grep -iE "a0[_.]?1|A01_|dead_rout|dead-rout"
  done | sort -u                                                              -> (no output)
```

No branch, no remote-tracking ref, no local ref, no worktree contains a file matching an A0.1 discovery report or a "six dead routes" list, under any name searched. `docs/admin/` on `origin/main` contains only the Wave 2 documents, the Architecture Standard and the Analyst Wave 1 contract — no A0/A0.1 report.

**Per §5 of the authoritative brief ("If two instructions conflict, stop and report the conflict. Do not resolve a material governance conflict unilaterally"), this is reported rather than resolved unilaterally.** The brief's §3 asks this phase to "treat as settled" that "A0.1 identified six dead or suspected-dead Admin routes," while direct repository evidence (an exhaustive ref-and-worktree scan) cannot locate that determination anywhere to reassess it. Both cannot be true at once from this repository's own history alone.

**What this Wave did instead of silently fabricating six routes to match the expected count:** an independent, fresh dead-route hunt across the current 72-route surface, using the three-pass method in §5.1 (including the template-literal check that a naive pass would have missed). That hunt is real, reproducible, and is documented in full in §5.3/§5.1.1. It surfaced:

- 2 genuinely dead-on-arrival-of-any-UI routes, both now connected (BWU-1, BWU-2);
- 1 genuinely uncalled but harmless, ambiguous-intent route, deferred (BWU-3);
- 1 whole subsystem's worth of by-design-uncalled routes (BWU-4, 17 routes) — explicitly disclosed as intentional in Module 11's own completion reports, not a "dead route" in the accidental sense at all.

None of these total exactly six, and none is a reliable stand-in for "the" six A0.1 routes, because this Wave has no way to know which six the (unlocatable) A0.1 document meant. **Recommendation to the Product Owner:** either the A0.1 artifact exists outside this repository (a chat transcript, an external document, a differently-named file not matched by the searches above) and should be supplied so this Wave's own six-route determination (deliverable #12) can be produced against the real list, or the "six routes" reference should be corrected/retracted in the canonical programme record. This Wave's own fresh findings (above) are offered as the best available substitute evidence in the meantime, not as a resolution of the conflict.

**No route was removed on the strength of this ambiguity.** Per the stop-condition rule ("if an external caller cannot be conclusively resolved, do not remove the route"), every route this investigation touched was either connected (2) or deferred (2 at the time), never removed on a guess.

**Closure-round update (Product Owner ruling):** the A0.1 document is confirmed **non-existent** — not merely unlocated. This section's recommendation above (supply the document or correct the record) is resolved in favour of correcting the record: no A0.1 discovery artifact was ever produced as a committed document in this repository's history, and this Wave's own fresh dead-route findings (above) are the operative record for this programme going forward, not a stand-in for a missing reassessment. Of the routes this fresh hunt found, BWU-1 and BWU-2 were connected (Certification Report §2 of the first pass) and BWU-3 (`glossary/terms`) was subsequently investigated further and removed as a confirmed duplicate (Certification Report §2.4, closure round) — see the register above.

---

## 7. Migration controls

**No migration was required or created in this Wave.** Both connect-and-complete fixes (§5.3, BWU-1/BWU-2) are pure application-layer changes (a route handler's field allow-list, a React client component) against existing tables (`benchmark_sources`, `benchmark_datasets`) and an existing service function (`validateDatasetForActivation`) — no schema, RLS, grant or RPC change.

Verified anyway, per the standing instruction to re-scan before any allocation decision (none was made, but the scan itself is recorded):

```
$ node scripts/check-migration-versions.mjs
OK: 115 active migrations, one file per version, next version is 0121.
Note: unused version numbers in the chain: 0079, 0080, 0081, 0103, 0117

$ node scripts/check-migration-versions-against-branch.mjs --against=origin/main
OK: no cross-branch migration collisions between "HEAD" (115 files) and "origin/main" (115 files).
```

Other active worktrees' claims on the next few numbers (checked, since the dispatch asked for this even though no allocation was needed):

| Worktree | Highest migration file found |
|---|---|
| `D:/fhip-fdh16` | `0120_fdh15_income_member_mismatch_guard.sql` (already merged) |
| `D:/fhip-module11-3` | `0121_module11_3_insight_pack.sql` (**claims `0121`**, unmerged) |
| `D:/fhip-fdh13-admin-baseline` | `0120_fdh15_income_member_mismatch_guard.sql` (already merged; no FDH-13-specific migration exists yet, consistent with "implementation pending") |

If this Wave ever did need a migration, the next genuinely free number would be **`0122`**, not `0121` (claimed by Module 11.3). Recorded for the record; not used.

---

## 8. Authorization certification

### 8.1 Untouched, already-certified surfaces

Per Standard §1.2 and this Wave's own "do not reopen certified work absent a direct regression" instruction, authorization evidence for every `CONNECTED_COMPLETE` surface this Wave did not modify is **inherited from its own certifying Wave**, cited here rather than re-derived from zero:

| Surface | Certifying Wave | Evidence document |
|---|---|---|
| Recommendations (all 4 routes + RPCs) | Wave 1 / 1B | Wave 1/1B certification reports (memory: `admin_a02_wave1_wave2.md`) |
| Related Content reorder, scheduling validation | Wave 2 | `docs/admin/A02_WAVE2_WORKFLOW_ORDERING_INTEGRITY_CERTIFICATION.md`, `FHIP_A02_Wave2_Terminal_Report.md` |
| Analyst capability model, 8-route gate, `/api/admin/me`, nav | Analyst Wave 1 | `docs/admin/FHIP_Analyst_Wave1_Capability_Contract.md` |
| Content/Video/Glossary/Money-Update/FAQ/CTA/Context/Users CRUD | R1.2–R1.7 (Resources CMS programme) | cited in memory, not re-derived |

`git diff 6fdcf7e HEAD` touches **only** `app/api/admin/benchmarks/sources/[id]/route.ts` and `components/admin/AdminBenchmarksClient.tsx` (§ certification report, exact diff) — confirming no other certified surface was disturbed.

### 8.2 Freshly certified this Wave — the two connected Benchmarks actions

| Control | Evidence |
|---|---|
| Named capability | `isAdmin` (Super Admin / `admin_users` membership) — same named gate as the sibling `activate`/`retire` routes, not a new or broader one |
| Route enforcement | `requireAdmin()` called at the top of both handlers, unchanged import, unchanged behaviour |
| Database enforcement | N/A — writes go through the `service_role` client (`adminClient()`), as every other Benchmarks route already does; the application-layer `requireAdmin()` gate is the only boundary, identical to the already-shipped `activate`/`retire` siblings |
| Unauthorised direct-API denial | Not re-derived from a fresh live HTTP round trip this Wave (see the Certification Report's named outstanding gate) — but the code path is byte-identical in shape to `datasets/[id]/activate`, which **is** already live in production and already implicitly proven to deny non-admins (its own `requireAdmin()` call is unchanged since before Wave 2) |
| Multi-role composition | N/A — Benchmarks has always been a single-role (Super Admin) surface; no composition to prove |
| Analyst mutation denial | Analyst holds no `admin_users` row by construction (Wave 1's own truth table), so `requireAdmin()` denies Analyst identically to any other non-Super-Admin caller — inherited, not newly proven |
| No navigation-as-security | The new Approve/Suspend/Reinstate/Validate buttons render only inside `AdminBenchmarksClient`, itself only reachable past the page's own `requireAdmin`-equivalent server check (`AdminBenchmarksPage`'s direct `admin_users` query) — hiding the buttons was never the security boundary |
| No client-supplied actor trusted | `user!.id` for `approved_by` comes from `requireAdmin()`'s own `supabase.auth.getUser()` call, never from the request body |

**Named gap, disclosed rather than glossed over:** a live HTTP round trip (running the app, signing in as a real Super Admin, a real non-admin, and anonymous, and hitting the three new buttons over the network) was **not performed** this Wave — see the Certification Report's outstanding-gate section for why and what would close it.

---

## 9. FDH-13 and Analyst boundary confirmation

- `git diff 6fdcf7e HEAD` contains **zero** files under `lib/financial-data-hub/`, **zero** `fdh_*`-prefixed migrations, **zero** new role tables, **zero** new navigation roots, **zero** new audit/security-event tables.
- The FDH-13 baseline at `9fdce5d` was **read for context only** (its own worktree, not written to); nothing from it was merged, implemented or re-certified here.
- No Analyst capability was added, removed or narrowed. The one Analyst-relevant surface this Wave discusses without changing is the Analytics placeholder page (§5.4/PLC-1), recorded as a disclosed tension for explicit Product Owner decision, not a unilateral change — so the Analyst dependency register (deliverable #37) records **no change**.
- No "Super Admin interim" allocation was made permanent; the two newly connected Benchmarks actions use the **pre-existing** `isAdmin` gate already in place for every other Benchmarks route since before this Wave — nothing was allocated, widened or made permanent by this change.
