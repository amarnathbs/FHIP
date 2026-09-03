# Admin A0.2 Wave 4 — Flat Authorization Register (PO4-1)

Every current `app/api/admin/**/route.ts` file and every exported HTTP method handler, individually. Companion to `docs/admin/A02_WAVE4_AUTHORIZATION_AUDIT_RESULTSTATE_REPORT.md`, which this file supersedes for the "area-level sampling" limitation that report's own §11/G2 gate disclosed.

## 0. Reconciled counts (measured fresh, not assumed)

```
$ grep -rlE "export (async )?(const|function) (GET|POST|PUT|PATCH|DELETE)" app/api/admin --include=route.ts | wc -l   -> 73
$ grep -rhoE "export (async )?(const|function) (GET|POST|PUT|PATCH|DELETE)" app/api/admin --include=route.ts | wc -l -> 105
```

| Method | Count |
|---|---:|
| GET | 50 |
| POST | 34 |
| PATCH | 9 |
| PUT | 6 |
| DELETE | 6 |
| **Total handlers** | **105** |

**Is 106 the authoritative handler count? No — 105 is.** The Round-2 dispatch's own arithmetic (`51 GET + 34 POST + 9 PATCH + 6 PUT + 6 DELETE = 106`) traces directly back to this session's own Round-1 report, which wrote "`GET` | ~51 (net +1 for `ai/insight-packs` GET...)" — an explicitly hedged approximation (the `~` and the parenthetical arithmetic, not a fresh count) that the dispatch's own reconciliation then took as exact. A fresh `grep` this round counts exactly **50** `GET` handlers, not 51, making the true total **105**. The **change from Wave 3's 104** (Wave 3's own closing figure, 71 routes) is fully accounted for: Wave 3 closed at 71 route files; Module 11.3 (already merged into `origin/main` before this Wave began, not new work this Wave did) added exactly 2 new route files (`ai/insight-packs` GET, `ai/insight-packs/generate` POST) with exactly 1 new handler each, for +2 routes / +2 handlers, giving 73 routes / 106 handlers **if** Wave 3's own 104 were itself exactly accurate — but Wave 3's own closing table's arithmetic (49+33+9+6+6 = 103, not 104) has the same one-off hedge in its own history. Rather than propagate a third approximation, this register recounts everything from the current tree directly: **73 route files, 105 handlers, reconciled exactly (50+34+9+6+6=105) against the flat list below.**

## 1. Classification legend

Uses the taxonomy from the dispatch's own §5 (Wave 4 Round 1 spec): `CAPABILITY_CORRECT`, `SUPER_ADMIN_CORRECT`, `GENERIC_ADMIN_TOO_BROAD`, `ANY_ROLE_TOO_BROAD`, `ROLE_NAME_INSTEAD_OF_CAPABILITY`, `NAVIGATION_ONLY`, `PAGE_ONLY`, `API_ONLY_ACCEPTABLE`, `API_WITHOUT_REQUIRED_DATABASE_CHECK`, `DATABASE_CORRECT_ROUTE_MISSING`, `MULTI_ROLE_INCORRECT`, `INACTIVE_ROLE_NOT_REJECTED`, `ANALYST_WRITE_RISK`, `MISSING_AUTHENTICATION`, `MISSING_AUTHORIZATION`, `DOCUMENTED_EXCEPTION`, `FUTURE_CAPABILITY_NOT_ACTIVE`.

Two shared, named patterns recur across many rows below and are defined once here rather than repeated per row:

- **Pattern R (RLS-backed single-resource read)**: a `GET .../[id]` route checks only authentication + country-confirmation, then queries through the caller's own RLS-scoped session. For every table this applies to, RLS has a `"public read active <x>"` policy (published/active rows readable by anyone) alongside a `"staff manage <x>"` policy (full CRUD, staff-only). A non-staff caller requesting an **active/published** row gets the real row (intentional — the same content the public site would show); requesting a **draft/inactive** row gets `404 Not Found` (RLS filters it to zero rows) — indistinguishable from a genuinely unknown id, which is a **defensible anti-enumeration design** (a distinguishing 403 would itself leak "this id exists, you're just not allowed to see it"), not a misleading-success defect. Classified `CAPABILITY_CORRECT` (DB-layer enforcement, correct-by-design API-layer absence). Verified this round for `resource_faqs`, `resource_videos`-backed posts, `resource_posts` (Money Updates/Glossary/generic Content share the same base table) via direct RLS-policy read (migration 0049).
- **Pattern V (versions/history read) — FOUND AND FIXED this round**: `GET .../[id]/versions` (4 routes: content, videos, glossary, money-updates) previously matched Pattern R's *shape* (auth+country only, RLS-backed) but NOT its *safe outcome* — `resource_post_versions`'s own RLS policy is staff-only for **every** row (no public-read equivalent, since revision history is never meant to be public even for published content), so a non-staff caller received a **200 with an empty array** — a misleading-success shape RLS alone cannot fix, unlike Pattern R's defensible 404. **Fixed this round**: each of the 4 routes now also checks `isResourceStaff()` and returns 403 for a non-staff caller. Reclassified from `DATABASE_CORRECT_ROUTE_MISSING` to `CAPABILITY_CORRECT`.

## 2. Flat register

### 2.1 Benchmarks (10 routes, 17 handlers) — `requireAdmin()` throughout, `SUPER_ADMIN_CORRECT`

Justification (not "already uses `requireAdmin()`" alone, per §6.2): Benchmarks is shared, cross-user methodology reference data rendered inside every user's own Financial Twin (migration `0011`'s own RLS comment: "world-readable... write-only via service-role"). A defect corrupts a platform-wide dataset, not one user's record. No narrower delegated capability exists in the current role model.

| # | Route | Method | Read/Mutation | Business action | Auth gate | Capability | Eligible roles | DB/RPC authority | Direct-bypass result | Audit | Result-state | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `benchmarks/cohorts` | GET | Read | List cohorts | `requireAdmin()` | Super Admin (`admin_users`) | Super Admin | service-role client (RLS N/A) | Direct table read blocked by RLS for `authenticated`/`anon` (world-readable is `benchmark_sources`/`values`, not `cohorts` write path) | N/A (read) | 200/`safeDbError`→409/422/503/500 | `SUPER_ADMIN_CORRECT` | `app/api/admin/benchmarks/cohorts/route.ts` |
| 2 | `benchmarks/cohorts` | POST | Mutation | Create cohort | `requireAdmin()` | Super Admin | Super Admin | service-role only; no `authenticated` INSERT grant | Direct insert as `authenticated` refused by grant | `AUDIT_NOT_REQUIRED` (cohort metadata, not a governance lifecycle event) | 201-shaped 200/422/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 3 | `benchmarks/datasets` | GET | Read | List datasets | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/datasets/route.ts` |
| 4 | `benchmarks/datasets` | POST | Mutation | Create dataset (draft) | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | `AUDIT_NOT_REQUIRED` (draft creation, not yet a governance decision) | 200/422/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 5 | `benchmarks/datasets/[id]/activate` | POST | Mutation | Activate dataset | `requireAdmin()` | Super Admin | Super Admin | service-role; validation + `benchmark_update_runs` insert (non-atomic with the UPDATE — pre-existing since migration `0011`, **not** rebuilt this round, see §12 residual) | as above | `AUDITED_COMPLETE` (both accept and reject paths insert an audit row) | 200/422 (validation)/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/datasets/[id]/activate/route.ts` |
| 6 | `benchmarks/datasets/[id]/retire` | POST | Mutation | Retire (supersede) dataset | `requireAdmin()` | Super Admin | Super Admin | service-role; `.single()` (PGRST116→404 via `safeDbError`) | as above | `AUDITED_COMPLETE` | 200/404/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/datasets/[id]/retire/route.ts` |
| 7 | `benchmarks/sources` | GET | Read | List sources | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/sources/route.ts` |
| 8 | `benchmarks/sources` | POST | Mutation | Create source (draft) | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | `AUDIT_NOT_REQUIRED` (draft creation) | 200/422/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 9 | `benchmarks/sources/[id]` | PUT (status field present) | Mutation | Approve/suspend/reinstate a source (lifecycle transition) | `requireAdmin()` (defence-in-depth) **+ `admin_transition_benchmark_source()` internal re-check** | Super Admin | Super Admin | **Pattern A RPC** (migration 0125) — atomic, `SECURITY DEFINER`, `auth.uid()`-derived actor, internal admin_users recheck, row-locked, audit-insert in the same transaction | RPC directly callable only by `authenticated`/`service_role` (EXECUTE revoked from `public`/`anon`); internal check refuses a non-admin/anonymous/null-actor caller identically — proven live via PGlite (Section 6/7 of the certification script) | **`AUDITED_COMPLETE`, atomic** (this round's central fix — was `AUDIT_MISSING_HIGH_RISK`/non-atomic in Round 1) | 200/401/403/404/422/500 (`safeDbError` fallback) | `SUPER_ADMIN_CORRECT` + `PATTERN_A_COMPLIANT` | `benchmarks/sources/[id]/route.ts`; migration `0125`; `scripts/admin_a02_wave4_benchmark_source_certification.mjs` (82/82) |
| 10 | `benchmarks/sources/[id]` | PUT (metadata fields only, no status) | Mutation | Edit source metadata (non-lifecycle) | `requireAdmin()` | Super Admin | Super Admin | service-role, field allow-list (unchanged from Wave 3) | Direct write blocked by grant | `AUDIT_NOT_REQUIRED` (not a lifecycle event) | 200/404/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 11 | `benchmarks/target-ranges` | GET | Read | List target ranges | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/target-ranges/route.ts` |
| 12 | `benchmarks/target-ranges` | POST | Mutation | Create target range | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | `AUDIT_NOT_REQUIRED` | 200/422/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 13 | `benchmarks/update-runs` | GET | Read | View audit/update-run log | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A (this IS the audit-log read surface) | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/update-runs/route.ts` |
| 14 | `benchmarks/validate` | POST | Read (preview only, no write) | Preview dataset-activation validity | `requireAdmin()` | Super Admin | Super Admin | N/A (read-only service function) | N/A | `NOT_AUDITED_NOT_REQUIRED` (no mutation) | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/validate/route.ts` |
| 15 | `benchmarks/values` | GET | Read | List observed values | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `benchmarks/values/route.ts` |
| 16 | `benchmarks/values` | POST | Mutation | Import observed values (structured insert) | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | `AUDIT_NOT_REQUIRED` (raw observed-value import, not a governance decision) | 200/422/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |

### 2.2 Recommendations (4 routes, 6 handlers) — `requireAdmin()` at API layer, Pattern B RPCs

| # | Route | Method | Read/Mutation | Business action | Auth gate | Capability | Eligible roles | DB/RPC authority | Direct-bypass result | Audit | Result-state | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 | `recommendations` | GET | Read | List (paginated) master+conditions | `requireAdmin()` | Super Admin | Super Admin | service-role, paginated (>1000-row fix, Wave 1B) | as above | N/A | 200/`safeDbError` (this round: paginated-fetch error path now unwraps to `safeDbError` instead of a raw re-thrown message) | `SUPER_ADMIN_CORRECT` | `recommendations/route.ts` |
| 18 | `recommendations` | POST | Mutation | Create recommendation + conditions | `requireAdmin()` | Super Admin | Super Admin | **Pattern B** `admin_upsert_recommendation_atomic` (migration `0109`, approved, not reopened) | RPC not directly callable by `authenticated` (Pattern B — server-boundary approved exception) | `AUDITED_COMPLETE` (RPC-internal, certified Wave 1B) | 200/409/422/500 (already safe pre-existing mapping, untouched) | `SUPER_ADMIN_CORRECT` + `PATTERN_B_APPROVED` | same file |
| 19 | `recommendations/[id]` | PATCH | Mutation | Edit recommendation + conditions | `requireAdmin()` | Super Admin | Super Admin | **Pattern B** (same RPC, update mode) | as above | `AUDITED_COMPLETE` | 200/404/422/500 (already safe pre-existing mapping, untouched) | `SUPER_ADMIN_CORRECT` + `PATTERN_B_APPROVED` | `recommendations/[id]/route.ts` |
| 20 | `recommendations/[id]` | DELETE | Mutation | Deactivate (soft-delete) recommendation | `requireAdmin()` | Super Admin | Super Admin | service-role, `.single()` | Direct write blocked by grant | `AUDIT_NOT_REQUIRED` (is_active toggle, not a Pattern-B-scoped action) — **residual, not assessed against §9 priority 3 this round, see §12** | 200/404 (PGRST116 via `safeDbError`, this round's fix)/`safeDbError` | `SUPER_ADMIN_CORRECT` | same file |
| 21 | `recommendations/gaps` | GET | Read | View unmatched-evaluation gap report | `requireAdmin()` | Super Admin | Super Admin | service-role | as above | N/A | 200/`safeDbError` | `SUPER_ADMIN_CORRECT` | `recommendations/gaps/route.ts` |
| 22 | `recommendations/upload` | POST | Mutation | Bulk CSV import (4 file types) | `requireAdmin()` | Super Admin | Super Admin | 3 file types: service-role upsert (now `safeDbError`-mapped); `conditions` file type: **Pattern B** `admin_import_recommendation_conditions` (migration `0107`, approved, not reopened) | RPC not directly callable by `authenticated` for the `conditions` path; other 3 blocked by grant | `AUDITED_COMPLETE` for `conditions` (via `logResourceAudit`, pre-existing); `AUDIT_NOT_REQUIRED` for placeholders/calculation_methods/master upserts (bulk reference-data upsert, not a governance decision — **residual, not assessed against §9 priority 5 this round, see §12**) | 200/413/422/500 (all 4 branches now `safeDbError`-mapped or already-safe) | `SUPER_ADMIN_CORRECT` + `PATTERN_B_APPROVED` (conditions only) | `recommendations/upload/route.ts` |

### 2.3 AI Admin (19 routes, ~28 handlers) — `requireAdmin()` throughout, `SUPER_ADMIN_CORRECT` (Module 11 boundary, §19 — inventory only)

Per this Wave's own §19: assess only, do not build UI, do not expand functionality, do not change Module 11's security controls. All 19 routes share the identical gate; individual business actions differ but the authorization story does not, so this section lists routes (not every method) with a shared verdict, per row.

| # | Route | Methods | Business action | Gate | Classification | Note |
|---|---|---|---|---|---|---|
| 23 | `ai/config-audit` | GET | View AI config change history | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | Audit source itself, already `AUDITED_COMPLETE` via `ai_config_audit` (trigger-written, migration 0115) |
| 24 | `ai/controls` | GET, PUT | View/change AI platform controls | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 25 | `ai/cost-limits/[id]` | PUT | Change a cost-limit row | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 26 | `ai/costs` | GET | View cost reporting | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 27 | `ai/entitlements` | GET | View entitlement config | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 28 | `ai/evaluations` | GET, POST | View/run evaluations | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 29 | `ai/insight-packs` | GET | List insight packs | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | Module 11.3 addition (already merged before this Wave) |
| 30 | `ai/insight-packs/generate` | POST | Trigger generation | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | Module 11.3 addition |
| 31 | `ai/kill-switch` | POST | Platform-wide AI stop | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | `AUDITED_COMPLETE` — dedicated `ai_operational_events` log, mandatory reason (already exceeds this Wave's own baseline audit bar) |
| 32 | `ai/models` | GET, POST | List/register AI models | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 33 | `ai/models/[id]` | PUT | Edit a model registry row | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 34 | `ai/models/[id]/enable` | POST | Enable a model | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 35 | `ai/models/[id]/disable` | POST | Disable a model | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 36 | `ai/prompts` | GET, POST | List/create prompts | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 37 | `ai/prompts/[id]` | PUT | Edit a prompt | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 38 | `ai/providers/[provider]` | PUT | Edit provider config | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 39 | `ai/runs` | GET | View run history | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 40 | `ai/safety-events` | GET | View safety-event log | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |
| 41 | `ai/usage` | GET | View usage reporting | `requireAdmin()` | `SUPER_ADMIN_CORRECT` | |

**No new authorization defect found here this round** (re-confirmed by direct read of `kill-switch`, `models`, `config-audit`, `insight-packs` — all gated identically; the remaining 15 assessed by the same grep-confirmed pattern, not individually re-read line-by-line this round — disclosed, not hidden, as a bounded-depth inspection for a domain this Wave is not authorised to modify).

### 2.4 Resources — Users & Roles (2 routes, 3 handlers)

| # | Route | Method | Business action | Auth gate | Capability | DB authority | Audit | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| 42 | `resources/users` | GET | List users + their Resources roles | auth + country | `canManageResources()` | service-role (needs `auth.admin.listUsers`) | N/A (read) | `CAPABILITY_CORRECT` | `resources/users/route.ts` |
| 43 | `resources/users/roles` | POST | Assign a Resources role | auth + country | `canManageResources()` | service-role only (zero `authenticated` grant on `resource_user_roles`) | **`AUDITED_COMPLETE`** — trusted actor, before/after state, self-lockout guard, `resource_audit_log` insert | `CAPABILITY_CORRECT` | `lib/resources/admin/userRoles.ts` |
| 44 | `resources/users/roles` | DELETE | Remove a Resources role | auth + country | `canManageResources()` | service-role only | `AUDITED_COMPLETE`, idempotent zero-row-safe | `CAPABILITY_CORRECT` | same |

### 2.5 Resources — Discovery (Related Content, CTAs, Context Mapping) (7 routes, 12 handlers)

| # | Route | Method | Business action | Capability | DB authority | Audit | Zero-row | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| 45 | `resources/related` | GET | List related-content links | `isResourceStaff()` (via file's own view check — read visibility) | RLS | N/A | N/A | `CAPABILITY_CORRECT` | `resources/related/route.ts` |
| 46 | `resources/related` | POST | Add a related-content link | `canManageDiscovery()` | service-role | `AUDIT_NOT_REQUIRED` (link add, not named §9 priority) | N/A | `CAPABILITY_CORRECT` | same |
| 47 | `resources/related/[id]` | DELETE | Remove a related-content link | `canManageDiscovery()` | service-role, **now `.select('id')`-checked** | `AUDIT_NOT_REQUIRED` | **Fixed this round** — 404 for already-gone id, was false-200 | `CAPABILITY_CORRECT` | `lib/resources/discovery/relatedAdmin.ts` |
| 48 | `resources/related/reorder` | PATCH | Reorder related-content links | `canManageDiscovery()` | **Pattern A** `admin_reorder_related_content` (migration 0116, Wave 2, not reopened) | `AUDITED_COMPLETE` (Wave 2) | Certified Wave 2, untouched | `CAPABILITY_CORRECT` + `PATTERN_A_COMPLIANT` | `resources/related/reorder/route.ts` |
| 49 | `resources/related/search-posts` | GET | Search posts to link | `isResourceStaff()` (read helper) | RLS/read-only RPC | N/A | N/A | `CAPABILITY_CORRECT` | `resources/related/search-posts/route.ts` |
| 50 | `resources/ctas` | GET | List CTAs | `isResourceStaff()` | RLS | N/A | N/A | `CAPABILITY_CORRECT` | `resources/ctas/route.ts` |
| 51 | `resources/ctas` | POST | Create CTA | `canManageDiscovery()` | service-role | `AUDIT_NOT_REQUIRED` | N/A | `CAPABILITY_CORRECT` | same |
| 52 | `resources/ctas/[id]` | GET | View one CTA + usage count | `isResourceStaff()` | RLS | N/A | N/A | `CAPABILITY_CORRECT` | `resources/ctas/[id]/route.ts` |
| 53 | `resources/ctas/[id]` | PATCH | Edit CTA | `canManageDiscovery()` | service-role | `AUDIT_NOT_REQUIRED` | N/A | `CAPABILITY_CORRECT` | same |
| 54 | `resources/context` | GET | List context mappings | auth + country only (Pattern R) | RLS | N/A | N/A | `CAPABILITY_CORRECT` (Pattern R) | `resources/context/route.ts` |
| 55 | `resources/context` | POST | Create context mapping | `canManageDiscovery()` | service-role | `AUDIT_NOT_REQUIRED` | N/A | `CAPABILITY_CORRECT` | same |
| 56 | `resources/context/[id]` | PATCH | Edit/reorder/activate mapping | `canManageDiscovery()` | service-role | `AUDIT_NOT_REQUIRED` | Not reviewed this round (only DELETE was in named scope — see §12) | `CAPABILITY_CORRECT` | `resources/context/[id]/route.ts` |
| 57 | `resources/context/[id]` | DELETE | Remove context mapping | `canManageDiscovery()` | service-role, **now `.select('id')`-checked** | `AUDIT_NOT_REQUIRED` | **Fixed this round** — 404 for already-gone id | `CAPABILITY_CORRECT` | `lib/resources/context/queries.ts` |

### 2.6 Resources — Content-type CRUD (Content/Videos/Glossary/Money-Updates/FAQs) (23 routes, ~40 handlers)

Grouped by shared shape — every content type follows the identical capability pattern (`isResourceStaff()` for list/view, `canCreateSpecialistContent()`/`canManageFaqs()` for create/mutate), confirmed individually per file this round (not assumed from one representative).

| # | Route | Method | Business action | Capability | Classification | Note |
|---|---|---|---|---|---|---|
| 58 | `resources/content` | GET | List generic content | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 59 | `resources/content` | POST | Create content | `isResourceStaff()` (list-level) **and** `canCreateResource()` (create-specific, confirmed on direct read) | `CAPABILITY_CORRECT` | |
| 60 | `resources/content/[id]` | GET | View one content item | auth + country (Pattern R) | `CAPABILITY_CORRECT` | |
| 61 | `resources/content/[id]` | PATCH | Edit content | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 62 | `resources/content/[id]/workflow` | POST | Workflow transition (submit/approve/publish/archive) | auth + country only; **Pattern A RPC** `transition_resource_post_status` is the authoritative check | `CAPABILITY_CORRECT` + `PATTERN_A_COMPLIANT` | RPC atomically writes `resource_workflow_history` + `resource_audit_log` — `AUDITED_COMPLETE` |
| 63 | `resources/content/[id]/versions` | GET | View revision history | **`isResourceStaff()` — added this round (Pattern V fix)** | `CAPABILITY_CORRECT` (was `DATABASE_CORRECT_ROUTE_MISSING`) | Fixed this round |
| 64 | `resources/content/[id]/slug-check` | GET | Check slug availability (boolean only) | auth + country only | `API_ONLY_ACCEPTABLE` | No real content disclosed (boolean), DB `unique` constraint is the real backstop |
| 65 | `resources/content/[id]/slug-check` | POST | Check content_id availability (boolean only) | auth + country only | `API_ONLY_ACCEPTABLE` | same |
| 66 | `resources/videos` | GET | List videos | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 67 | `resources/videos` | POST | Create video | `canCreateSpecialistContent()` | `CAPABILITY_CORRECT` | |
| 68 | `resources/videos/[id]` | GET | View one video | auth + country (Pattern R) | `CAPABILITY_CORRECT` | |
| 69 | `resources/videos/[id]` | PATCH | Edit video | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 70 | `resources/videos/[id]/workflow` | POST | Workflow transition | Pattern A RPC | `CAPABILITY_CORRECT` + `PATTERN_A_COMPLIANT` | |
| 71 | `resources/videos/[id]/versions` | GET | View revision history | **`isResourceStaff()` — added this round** | `CAPABILITY_CORRECT` | Fixed this round |
| 72 | `resources/glossary` | GET | List glossary terms | `isResourceStaff()` (confirmed on direct read — corrected from an earlier draft of this row) | `CAPABILITY_CORRECT` | |
| 73 | `resources/glossary` | POST | Create glossary term | `canCreateSpecialistContent()` | `CAPABILITY_CORRECT` | |
| 74 | `resources/glossary/[id]` | GET | View one term | auth + country (Pattern R) | `CAPABILITY_CORRECT` | |
| 75 | `resources/glossary/[id]` | PATCH | Edit term | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 76 | `resources/glossary/[id]/workflow` | POST | Workflow transition | Pattern A RPC | `CAPABILITY_CORRECT` + `PATTERN_A_COMPLIANT` | |
| 77 | `resources/glossary/[id]/versions` | GET | View revision history | **`isResourceStaff()` — added this round** | `CAPABILITY_CORRECT` | Fixed this round |
| 78 | `resources/glossary/similar` | GET | Suggest similar terms (editor aid) | auth + country only | `API_ONLY_ACCEPTABLE` | Read-only suggestion helper, RLS-scoped |
| 79 | `resources/money-updates` | GET | List money updates | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 80 | `resources/money-updates` | POST | Create money update | `canCreateSpecialistContent()` | `CAPABILITY_CORRECT` | |
| 81 | `resources/money-updates/from-template` | POST | Create from template | `canCreateSpecialistContent()` | `CAPABILITY_CORRECT` | |
| 82 | `resources/money-updates/templates` | GET | List templates | auth + country only | `API_ONLY_ACCEPTABLE` | Read-only, no per-record sensitivity |
| 83 | `resources/money-updates/[id]` | GET | View one money update | auth + country (Pattern R) | `CAPABILITY_CORRECT` | |
| 84 | `resources/money-updates/[id]` | PATCH | Edit money update | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 85 | `resources/money-updates/[id]/workflow` | POST | Workflow transition | Pattern A RPC | `CAPABILITY_CORRECT` + `PATTERN_A_COMPLIANT` | |
| 86 | `resources/money-updates/[id]/versions` | GET | View revision history | **`isResourceStaff()` — added this round** | `CAPABILITY_CORRECT` | Fixed this round |
| 87 | `resources/faqs` | GET | List FAQs | `isResourceStaff()` | `CAPABILITY_CORRECT` | |
| 88 | `resources/faqs` | POST | Create FAQ | `canManageFaqs()` | `CAPABILITY_CORRECT` | |
| 89 | `resources/faqs/[id]` | GET | View one FAQ | auth + country (Pattern R) | `CAPABILITY_CORRECT` | |
| 90 | `resources/faqs/[id]` | PATCH | Edit FAQ | `canManageFaqs()` | `CAPABILITY_CORRECT` | |
| 91 | `resources/faqs/[id]` | DELETE | Delete FAQ (blocked if linked) | `canManageFaqs()` | `CAPABILITY_CORRECT` | Already has its own defence-in-depth 409 for linked content (Wave-independent, pre-existing) |
| 92 | `resources/faqs/[id]/links` | GET | View FAQ's linked content | auth + country only | `API_ONLY_ACCEPTABLE` | Read-only |
| 93 | `resources/faqs/[id]/links` | POST | Link FAQ to content | `canManageFaqs()` | `CAPABILITY_CORRECT` | |
| 94 | `resources/faqs/[id]/links` | DELETE | Unlink FAQ from content | `canManageFaqs()` | `CAPABILITY_CORRECT` | Not reviewed for zero-row contract this round (not named in DEF4-10 — residual, see §12) |
| 95 | `resources/faqs/search-posts` | GET | Search posts to link | auth + country only | `API_ONLY_ACCEPTABLE` | Read-only |
| 96 | `resources/dashboard` | GET | Resources admin dashboard summary | auth + country only (relies on `isResourceStaff`-equivalent check inline — confirmed present) | `CAPABILITY_CORRECT` | |

### 2.7 Resources — shared lookup data (4 routes, 5 handlers) and self-resolution (1 route, 1 handler)

**Correction, caught during this document's own review before publication**: an earlier draft of this section asserted `categories`/`authors`/`tags`/`sources` GET have no explicit capability check ("auth + country only"). Direct re-read of all four files shows this was **wrong** — every one of them calls `isResourceStaff()` and returns 403 for a non-staff caller, identical in shape to the Content-type CRUD list routes in §2.6. Corrected below; this mistake is disclosed rather than silently fixed, since the whole point of a flat register is that every row is independently checked, not inferred from a file-list grep alone (this specific error came from mis-transcribing which grep result group four filenames belonged to, not from re-reading the files — the fix was to actually open them).

| # | Route | Method | Business action | Capability | Classification | Note |
|---|---|---|---|---|---|---|
| 97 | `resources/categories` | GET | List categories (editor filter dropdown) | `isResourceStaff()` | `CAPABILITY_CORRECT` | Comment in the file itself documents a prior Phase-A-Wave-1 narrowing from a coarser check that let Analyst through to a misleading 200 — already fixed in an earlier wave, re-confirmed unchanged this round |
| 98 | `resources/authors` | GET | List active authors (editor picker) | `isResourceStaff()` | `CAPABILITY_CORRECT` | Same prior-wave narrowing note |
| 99 | `resources/tags` | GET | List active tags (editor picker) | `isResourceStaff()` | `CAPABILITY_CORRECT` | Same |
| 100 | `resources/sources` | GET | Search citation sources (editor picker) | auth + country only (Pattern R — RLS-backed) | `CAPABILITY_CORRECT` | **Resolved during this document's own review**: `resource_sources` has `"public read public sources"` (is_public=true) alongside `"staff read all sources"` (migration 0049) — a non-staff caller sees only already-public sources, exactly Pattern R, not a gap |
| 101 | `resources/sources` | POST | Create citation source | `isResourceStaff()` | `CAPABILITY_CORRECT` | Confirmed present on direct read |
| 102 | `me` | GET | Resolve caller's own Admin nav capabilities | none by design (never a 403, documented contract) | `DOCUMENTED_EXCEPTION` | Deliberate — see the route's own header comment; every destination it informs is independently gated |

**Reconciliation**: every one of the 73 route files appears at least once across §2.1–2.7; the authoritative per-handler count is the 105 total in §0, not a second arithmetic pass here.

## 3. New findings this round, beyond the Round-1 report

| Finding | Classification (before) | Classification (after) | Status |
|---|---|---|---|
| 4 revision-history routes (`content`/`videos`/`glossary`/`money-updates` `[id]/versions`) returned a misleading 200-empty-array to non-staff callers | `DATABASE_CORRECT_ROUTE_MISSING` | `CAPABILITY_CORRECT` | **Fixed** — `isResourceStaff()` added, 403 for non-staff, tests added (`tests/unit/adminA02Wave4VersionsStaffGate.test.ts`, 8/8 passing) |
| `resources/sources` GET (search/picker) has no explicit capability check, unlike its own sibling POST | initially unclear | `CAPABILITY_CORRECT` | **Resolved, no fix needed** — `resource_sources`' own RLS (`"public read public sources"` + `"staff read all sources"`, migration 0049) already restricts a non-staff caller to public-only rows, matching Pattern R exactly |

## 4. Residuals carried into §12 of the main report (not re-litigated here)

Dataset activate/retire's non-atomic audit-then-update-then-audit sequencing (pre-existing since migration `0011`, not rebuilt this round — only the NEW source-lifecycle path was required to be atomic by the dispatch); Recommendations DELETE/upload's non-Pattern-B branches' audit-priority classification against §9 priorities 3/5; `context/[id]` PATCH's zero-row contract (only DELETE was named in DEF4-10); `faqs/[id]/links` DELETE's zero-row contract (same reason).
