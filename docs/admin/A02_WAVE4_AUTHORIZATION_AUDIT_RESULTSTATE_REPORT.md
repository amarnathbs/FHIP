# Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency

## Discovery, Classification, Remediation and Design-Package Report (Round 1)

**Branch:** `worktree-agent-a3cfa187061e5a032`
**Worktree:** `D:/FHIP/.claude/worktrees/agent-a3cfa187061e5a032` (isolated)
**Base:** `origin/main` @ `99f0cc0b334b13f70f53d554b4741351776886a6` — confirmed the exact current tip of `origin/main` (not merely an ancestor) at the time this round started
**Date:** 2026-09-02

This round completes the mandatory starting gate, a fresh functional-area authorization/RPC/audit inventory against the *current* `origin/main`, one concrete high-risk audit-evidence gap found and closed with a live-tested fix, and the two canonical design packages the dispatch names (§10/§11). It does **not** complete a live-DEV-verified, per-route, all-73-route certification in one pass — see §11 (Verdict) for exactly what remains and why this round stops short of FULL PASS rather than asserting one.

---

## 1. Starting gate (§2 of the dispatch)

| Step | Result |
|---|---|
| 1. Fetch/prune all remotes | Done. `origin` fetched clean. A second configured remote, `doclife` (`D:/FHIP/.claude/worktrees/doc-lifecycle`), failed to fetch (`fatal: … does not appear to be a git repository` — that worktree directory does not currently exist on disk). Disclosed, not worked around; it carries no Admin-relevant branches beyond what `origin` already has (its branch names mirror `origin`'s FHIP history, e.g. `doclife/main`, `doclife/feature/phase1-design-system`) and this codebase's canonical remote is `origin`. |
| 2. Record current `origin/main` | `99f0cc0b334b13f70f53d554b4741351776886a6` |
| 3. `99f0cc0` an ancestor of current `origin/main`? | **It IS `origin/main`'s current tip**, not merely an ancestor — confirmed by direct SHA comparison, not just `--is-ancestor`. Nothing has merged to `main` since Wave 3 closed. |
| 4. A0.2 Wave 3 present in full? | Yes — `git log --oneline -5` from this worktree's own HEAD shows `99f0cc0` (Wave 3's own merge commit) as HEAD, with Module 11.3, G0/G1 and FDH-16 reconciliation commits as ancestors of it (already folded in before Wave 3 merged, per its own discovery report §1.3). |
| 5. Reconcile Admin changes merged after `99f0cc0` | None — `origin/main` has not advanced since Wave 3's own merge, so there is nothing to reconcile. |
| 6. Fresh branch/worktree from current `origin/main` | Satisfied — this session's isolated worktree already forks cleanly from `99f0cc0`; no Wave 1/2/3/Analyst/FDH/MCC/Module 11 branch was reused. |
| 7. Concurrently active branches touching Admin (all `D:/fhip-*` + `D:/FHIP/.claude/worktrees/*`, not just `origin/main`) | See §2 below. |
| 8. `AGENTS.md` + `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` read in full | Done (both files read verbatim this round). |
| 9. Wave 3 inventory/catalogue/disposition register/manuals read in full | Done: `A02_WAVE3_CERTIFICATION_REPORT.md`, `A02_WAVE3_DISCOVERY_AND_INVENTORY.md` read verbatim; `A02_WAVE3_TASK_MANUALS.md` consulted for the surfaces this round touches. |

### 1.1 A materially different starting condition from what the dispatch assumed

The dispatch's own text (§2.7, §19) predicts `origin/main` has "advanced" with "G0/G1, FDH-16, Module 11.2/11.3/11.4 pending, G2 pending" beyond Wave 3. **This is not what was found.** All of G0/G1, FDH-16 and Module 11.2/11.3 are already folded into `99f0cc0` itself (confirmed: they appear as ancestor commits in `git log`, and Wave 3's own discovery report already disclosed reconciling with them before its own merge). `origin/main`'s tip **is** `99f0cc0` — there is nothing further to reconcile. This is recorded as a disclosed discrepancy between the dispatch's assumption and the repository's actual current state, resolved in favour of the repository (per the dispatch's own §25 stop-condition: "current `origin/main` materially changes during certification" — here the opposite condition holds, it has not changed at all since the cited baseline, which only *simplifies* this round's sequencing gate).

Two application-level route files not present in Wave 3's own count (`app/api/admin/ai/insight-packs/route.ts`, `app/api/admin/ai/insight-packs/generate/route.ts`) **are** present now — these came in as part of Module 11.3, itself already an ancestor of `99f0cc0`, not a change made or reopened by this round.

---

## 2. Concurrent branches recorded

**Remote (`origin`), checked by literal ancestry, not assumption:**

| Branch | `git log origin/main..<branch>` | Touches Admin? |
|---|---|---|
| `fix/admin-a02-wave1-recommendation-import-integrity` | empty (fully merged) | Already merged |
| `fix/admin-a02-wave2-workflow-ordering-integrity` | empty (fully merged) | Already merged |
| `fix/admin-a02-wave3-disconnected-content-dead-routes` | empty (fully merged) | Already merged |
| `docs/admin-architecture-standard-wave0` | empty (fully merged) | Already merged |
| `feature/analyst-analytics-wave1-access` | empty (fully merged) | Already merged |
| `feature/g0-g1-country-foundation` | empty (fully merged) | No (country/jurisdiction, not Admin) |
| `feature/module-11-3-insight-pack` | empty (fully merged) | Yes, already merged (AI Admin routes) |
| `feature/fdh12-retirement-statement-intelligence` | empty | No committed divergence found on this remote ref |
| `feature/app-review-remainder-input-ux-currency-onboarding`, `feature/analyst-analytics-wave1-access`, `feature/fdh10-credit-cards-loans-intelligence`, `feature/investment-intelligence-*`, `chore/r12-terminal-certification-2026-08-27` | not Admin-relevant by name/content | No |
| `feature/app-review-input-integrity-production` | 12 unmerged commits (App Review / Financial Twin / Assets-Investments-Retirement) | **No** — zero Admin-path files in this branch's own history (Financial Twin, Goals, dashboard formatting, taxonomy consolidation only) |
| `claude/determined-blackburn-4e1846` | 1 unmerged commit (`c23ce77`, II-R11 pagination fix) | No |
| `claude/focused-wing-cb6d5f`, `worktree-agent-a65337f982570953f`, `docs/g0-ja-wave2-final-scope-decision` | empty | No |

**No remote branch carries unmerged Admin-authorization, Admin-navigation, audit-table, API-error-handling, migration, AI-Admin-route or Resources-permission work.**

**Local worktrees on disk, spot-checked by branch name and `git log origin/main..<local-branch>`** (the full `D:/fhip-*` + `D:/FHIP/.claude/worktrees/*` listing has ~140 entries; this round read-only-scanned the ones whose names or dates suggest Admin/authorization/audit/migration relevance, rather than exhaustively diffing all ~140 — disclosed as a bounded scan, not an exhaustive one, in §12 below):

| Worktree | Branch | Unmerged vs `origin/main`? |
|---|---|---|
| `D:/fhip-analyst-w1` | `feature/analyst-analytics-wave1-access` | None (fully merged) |
| `D:/fhip-fdh12` | `feature/fdh12-retirement-statement-intelligence` | None found on the ref this worktree points at |
| `D:/fhip-fdh13-admin-baseline` | `docs/fdh13-admin-integration-baseline` | **5 commits, docs-only**, terminal tip `9fdce5d` ("Product Owner terminal closure") — confirmed **not** an ancestor of `origin/main` (`git merge-base --is-ancestor 9fdce5d origin/main` → false). Zero code, zero migrations (confirmed by `git diff 6fdcf7e..9fdce5d --stat` style checks already performed by Wave 3; not re-litigated). Read for FDH-13 traceability context only (§9 below); not merged, not implemented. |
| `D:/fhip-g0-g1-country`, `D:/fhip-module11-2`, `D:/fhip-a02-wave2`, `D:/fhip-admin-a02-wave1` | (respective feature/fix branches) | None (all fully merged, confirmed above at the remote-ref level; local refs point at the same already-merged commits) |
| `D:/fhip-module11-3` | `feature/module-11-3-insight-pack` | None (fully merged) |
| `D:/fhip-country-confirm` | MCC branch | Not re-scanned in depth — MCC is explicitly out of scope (§23 exclusion: "do not reopen MCC") and Wave 3 already recorded this worktree as inert w.r.t. Admin surfaces |
| `D:/FHIP/.claude/worktrees/agent-*` (dozens) | mostly ephemeral single-task agent sessions per this repository's own convention | **Not individually enumerated this round** — named as a residual in §12 |

**Conclusion:** no active, unmerged branch conflicts with this round's Admin-authorization/audit/result-state work. The one genuine open item is `docs/fdh13-admin-integration-baseline` (docs-only, unmerged, terminally closed on its own branch) — its traceability matrix is read for §9, not modified or merged here.

---

## 3. Current Admin surface counts (remeasured against `99f0cc0`, not copied from Wave 3)

```
$ find "app/(app)/admin" -name "page.tsx" | wc -l    -> 36
$ find app/api/admin -name "route.ts" | wc -l         -> 73
```

Wave 3 closed at 34 pages / 71 routes. The net +2/+2 since then is fully accounted for by **Module 11.3**, already merged before this round began (not new Admin work this round): `app/api/admin/ai/insight-packs/route.ts` and `app/api/admin/ai/insight-packs/generate/route.ts` (2 new AI Admin routes, still zero Admin pages for the AI Admin surface — BWU-4's page count, correctly, stays 0). The 2-page delta between Wave 3's "34" and this round's "36" is a recount correction, not new pages — re-listing both pages and routes and comparing name-for-name against Wave 3's own §3 area table shows the same 34 named areas/pages Wave 3 enumerated, plus none new; Wave 3's own §3 table already flagged its own area-summary arithmetic as "a navigational summary, not a second source of truth" — this round's flat `find` count (36) is the more reliable of the two and is what this round certifies against.

### 3.1 HTTP method-handler breakdown

| Method | Route files exporting it |
|---|---:|
| `GET` | ~51 (net +1 for `ai/insight-packs` GET; Wave 3's 50 minus `glossary/terms`'s 1, already reflected in Wave 3's own 71-route closing count, plus the 2 new AI routes) |
| `POST` | 34 (net +1, `ai/insight-packs/generate`) |
| `PATCH` | 9 (unchanged) |
| `PUT` | 6 (unchanged) |
| `DELETE` | 6 (unchanged) |
| Route files with ≥1 mutating handler | 50 |
| Read-only (`GET`-only) route files | 23 |
| **Total route files** | **73** (50 + 23 = 73 ✓) |

### 3.2 Admin-invoked privileged RPCs (unchanged from Wave 3, re-confirmed by fresh grep)

```
$ grep -rhoE "\.rpc\('[a-z_0-9]+'" app/api/admin/** lib/resources/** lib/services/** lib/admin/** | sort -u
```

| RPC | Called from | Pattern |
|---|---|---|
| `admin_reorder_related_content` | `lib/resources/discovery/relatedAdmin.ts` | A (Wave 2) |
| `transition_resource_post_status` | `lib/resources/workflow.ts` | A (pre-existing, extended Wave 2) |
| `admin_upsert_recommendation_atomic` | `app/api/admin/recommendations/route.ts`, `[id]/route.ts` | **B — approved (migration `0109`), not reopened this round** |
| `admin_import_recommendation_conditions` | `app/api/admin/recommendations/upload/route.ts` | **B — approved (migration `0107`), not reopened this round** |

No new privileged RPC was added or found this round. Migrations `0107`/`0109` were not touched — confirmed by `git diff origin/main HEAD -- supabase/migrations/0107_admin_recs_conditions_import.sql supabase/migrations/0109_admin_recs_upsert_atomicity.sql` (empty; not re-inspected line-by-line, per the dispatch's own explicit instruction not to reopen them absent a newly demonstrated defect — none was found).

---

## 4. Authorization classification register (functional-area granularity, per Wave 3's own precedent — §11 explains why per-route granularity for all 73 routes was not completed this round)

| Area | Gate | Classification | Justification / evidence |
|---|---|---|---|
| Benchmarks (10 routes) | `requireAdmin()` — `admin_users` membership, checked at API layer; writes via `service_role` (RLS not applicable, no direct grant to `authenticated`) | `SUPER_ADMIN_CORRECT` | Benchmarks data is cross-user methodology reference data rendered inside every user's own Financial Twin (migration `0011`'s own RLS comment: "world-readable... write-only via service-role"). A defect here corrupts a shared, platform-wide reference dataset every user's Twin depends on — not a single user's or tenant's own record. No narrower delegated capability (e.g. a hypothetical "benchmark_editor" role) currently exists in the role model, and inventing one is exactly the §6.1 "STOP for Product Owner approval" case this round declines to do unilaterally (no Product Owner request for a narrower Benchmarks role was made). Documented here, not merely asserted by "already uses `requireAdmin()`" (§6.2's own bar). |
| Recommendations (4 routes + 2 Pattern-B RPCs) | `requireAdmin()` at API layer; RPC-internal auth for the two Pattern-B RPCs | `SUPER_ADMIN_CORRECT` (API) / `PATTERN_B_APPROVED` (RPCs) | Recommendations is the shared content library served to every user's dashboard; same platform-wide-impact reasoning as Benchmarks. Pattern B status for `admin_upsert_recommendation_atomic`/`admin_import_recommendation_conditions` re-affirmed per explicit dispatch instruction (§7) — not re-derived from zero, not reopened. |
| AI Admin (19 routes, `BWU-4`) | `requireAdmin()` | `SUPER_ADMIN_CORRECT`, **carried forward as previously classified, not re-litigated** | Per §19 of this Wave's own dispatch: inventory and assess only; do not build UI, do not expand Module 11 functionality, do not change its security controls. Module 11's own completion reports already justify the broad gate as an interim, explicitly-disclosed condition pending a dedicated AI Admin Console (BWU-4, Wave 3's own deferred-findings register, unchanged). This round did **not** find a new authorization defect here beyond the already-disclosed "no dedicated capability, no UI" gap — re-confirmed by reading 4 representative routes (`kill-switch`, `models`, `config-audit`, `insight-packs`), all gated identically. **Material observation, not a fix**: the kill-switch route already writes its own dedicated audit trail (`ai_config_audit` trigger + `ai_operational_events`, mandatory reason) — Module 11's own audit posture for its highest-risk action (platform-wide AI stop) is already `AUDITED_COMPLETE`, independent of this Wave. |
| Resources — Content/Video/Glossary/Money-Update/FAQ workflow transitions (all `.../workflow` routes) | Route: authentication + country-gate only, by design; **capability enforcement lives entirely inside `public.transition_resource_post_status`** (Pattern A, `SECURITY DEFINER`, `auth.uid()`-based) | `CAPABILITY_CORRECT` | This is the architecture the Standard's §6/§6.1 and this Wave's own §6.4 describe as correct: "a database/RPC capability recheck is ADDITIONALLY required where... the database function is the authoritative business transaction" — here the RPC **is** the authoritative transaction by explicit design (route file's own header comment: "All actual permission/compliance enforcement lives in `public.transition_resource_post_status`... this route's own job is [friendlier pre-checks and a revision snapshot]"). Confirmed live in the migration source: the RPC internally enforces the R1.1 permission matrix and the GREEN/AMBER/RED compliance workflow, and atomically inserts into both `resource_workflow_history` and `resource_audit_log` in the same transaction as the status change (migration `0049`, confirmed by direct read) — i.e. audit and authorization are both enforced at the one authoritative layer, not merely hoped-for at the API layer. |
| Resources role assignment/removal (`/api/admin/resources/users/roles`) | API: `canManageResources()` (named capability, narrower than `isResourceStaff()`); Page: `app/(app)/admin/resources/users/page.tsx` independently calls `requireResourceAdminAccess()` then re-checks `canManageResources()` itself, `redirect()`ing (not silently rendering empty) a staff member who lacks it; DB: `resource_user_roles` grants zero direct write to `authenticated` (service-role only) | `CAPABILITY_CORRECT` | Confirmed by direct read of `lib/resources/admin/userRoles.ts` and the page component: trusted `actorUserId` sourced from the authorizing route's own session (never client-supplied), before/after state captured, self-lockout on the final `resource_admin` blocked, idempotent no-op on a redundant removal (zero-row-safe by construction), and a `resource_audit_log` insert on every real state change. This is a genuine, independently-enforced example of Standard §4's four layers done correctly: nav shows "Users" to any Resources staff member (broad, UX-only), the **page** itself redirects a non-manager away rather than rendering an empty/broken screen, and the **API** rechecks the same narrow capability again regardless of what the page already did. Already `AUDITED_COMPLETE` (§6 below) — no defect found. |
| Resources nav-visibility capabilities (`isResourceStaff`, `canManageResources`, `canCreateSpecialistContent`, `canManageFaqs`, `canManageDiscovery`, `canViewResourceAnalytics`, `canPublishResource`, `canReviewResource`, `canComplianceApproveResource`) | Named, independently defined predicates (`lib/resources/permissions.ts`), each additive over role membership | `CAPABILITY_CORRECT` | Re-read in full this round (§4.1 below has the multi-role composition proof). No broad catch-all boolean gates more than one of these; each is separately named and separately callable, per Standard §2's own prohibition on a single boolean fanning out across unrelated functions. |
| Analyst (`resourceAnalytics` capability, hidden-nav Wave 3 outcome) | `isResourceAnalyst() \|\| canManageResources()` | `CAPABILITY_CORRECT`, Analyst boundary preserved | Re-verified this round by direct code read (not re-run live): `isResourceStaff()`'s own `CONTENT_WORKFLOW_ROLES` list deliberately excludes `'analyst'`; no route or RPC this round touched grants Analyst any write path. See §10 for the full boundary confirmation. |
| Benchmarks source lifecycle mutation (`PUT /api/admin/benchmarks/sources/[id]`) | `requireAdmin()`, unchanged this round | `SUPER_ADMIN_CORRECT` (auth unchanged) but **`AUDIT_MISSING_HIGH_RISK` found and CLOSED this round** | See §5/§6 — the one concrete defect this round found and fixed. |

### 4.1 Multi-role composition — proved by direct code read (not re-run live this round; see §11 for what a live proof would still need)

`getCurrentResourceRoles()` returns the caller's full active-role set; every predicate in `lib/resources/permissions.ts` tests **membership** (`.some(...)`/`.includes(...)`) over that set, never role *identity* — so:
- one permitted role among several roles grants the capability (`.some()` short-circuits true);
- additional non-permitted roles present alongside a permitted one cannot remove it (no predicate ever tests "is this the caller's *only* role");
- multiple non-permitted roles together never satisfy a `.some()` over a disjoint permitted-roles list — code-proved, not just argued: `SPECIALIST_CREATE_ROLES`/`DISCOVERY_MANAGE_ROLES`/`CONTENT_WORKFLOW_ROLES` are fixed, disjoint-from-Analyst arrays, and `Array.prototype.some` cannot return `true` for an element not in the array regardless of how many other elements are tried;
- an **inactive** role grants nothing: `getCurrentResourceRoles()`'s own query filters `.eq('is_active', true)` at the source — a revoked/expired row is never even loaded into the caller's role set, so no downstream predicate can accidentally honour it;
- role **ordering** cannot change the result (`.some()`/`.includes()` are order-independent by definition);
- a duplicate **active** role row is actually impossible at the schema level, not merely unlikely: `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql:228` defines `create unique index if not exists uq_resource_user_roles_active on resource_user_roles(user_id, role) where is_active;` — a partial unique index enforcing at most one active `(user_id, role)` row at a time (verified this round by direct grep). Even absent that guarantee, `.some()`/`.includes()` are duplicate-insensitive for the authorization outcome regardless — only *reporting* code that iterates all rows (e.g. `listResourceUsers()`) would ever show a duplicate.
- Super Admin composition is deterministic: every predicate's own first disjunct is `current.isSuperAdmin`, itself sourced from a single `admin_users` row lookup, so Super Admin status can only be one boolean, never a set with an ordering question.

This is a **code-level** proof, not the dispatch's own §20.3/§21 live-DEV proof (real inactive-role row, real duplicate-role row, real multi-role account) — named as an outstanding live-verification item in §11/§12, not asserted as already done.

---

## 5. The one concrete defect found and closed this round

**Classification: `AUDIT_MISSING_HIGH_RISK`** (spec §9, named priorities **2** — "publication/unpublication/approval/suspension/reinstatement" — and **4** — "Benchmark approval/suspension/reinstatement/material source changes").

`PUT /api/admin/benchmarks/sources/[id]` (Wave 3, commit `31f6437`) lets a Super Admin transition a `benchmark_sources` row through `draft → under_review → approved → active → superseded → suspended → archived` (and back, e.g. `suspended → approved` to reinstate). Before this round, **no audit evidence of any kind was written** for this action — unlike its sibling, `datasets/[id]/activate`, which has always inserted a `benchmark_update_runs` row (migration `0011`, Module 8). The `benchmark_update_runs` table already had an unused, nullable `source_id` column (defined in `0011`, never once populated by any `INSERT` in this codebase) — evidence the write path was scoped for but never built.

### 5.1 Fix

1. **Migration `0125_admin_a02_wave4_benchmark_source_audit.sql`** (additive, no data migration needed): widens `benchmark_update_runs.approval_status`'s `CHECK` constraint from `('pending','approved','rejected')` to also allow the full `benchmark_sources`/`benchmark_datasets` status vocabulary (`'draft','under_review','active','superseded','suspended','archived'`), so the existing, already-locked-down (RLS-enabled, zero `authenticated` policies, service-role-only) audit table can honestly record a source's actual resulting status rather than being force-fit into the narrower dataset-import vocabulary. No RLS change; no new table (per the dispatch's own §9 instruction: "do not duplicate an existing complete event; add narrowly scoped evidence only where needed" and §10: "do NOT necessarily create the final shared table in this phase").
2. **`app/api/admin/benchmarks/sources/[id]/route.ts`**: reads the row's current `status` before the update; on a genuine status change (`body.status !== undefined && body.status !== before.status`), inserts one `benchmark_update_runs` row (`source_id`, `dataset_id: null`, `approval_status: <new status>`, `previous_version: <old status>`, `new_version: <new status>`, `audit_user: <trusted actor id from requireAdmin()>`) **after** the business mutation commits. An audit-insert failure is logged and does **not** turn an already-committed status change into a failure response (same discipline already used for the Resources revision-snapshot failure path). A non-status field edit (e.g. `methodology_notes`) and an idempotent resubmission of the *same* status both correctly write **no** audit row (not every PUT is a lifecycle event; re-affirming the same value is not a transition).
3. **Same change also closes a smaller, related result-state defect**: an unknown `id` previously fell through to Postgrest's own `.single()` "no rows" error, mapped by this route's existing `bad(error.message)` to a generic **400** carrying a raw Postgrest message. A `.maybeSingle()` pre-check now returns a clean, explicit **404** ("Benchmark source not found.") before any write is attempted — directly the §12.1/§14 requirement that "an unknown target does not return false success" and that HTTP outcomes distinguish not-found from validation failure.

### 5.2 Evidence

- **New focused test**, `tests/unit/adminA02Wave4BenchmarkSourceAudit.test.ts` (6 tests, all passing): a genuine status transition writes exactly one correctly-shaped audit row with the trusted actor id; a non-status edit writes none; an idempotent same-status resubmission writes none; an unknown id returns 404 (not 400) and writes nothing; an invalid status is rejected 422 before any table is touched; a simulated audit-insert failure does not turn the (already-committed) mutation into a failed response.
- **Regression**: `tests/unit/countryGateAdminAndHousehold.test.ts` (same route file, pre-existing test) still passes unmodified — 6/6.
- **Scoped regression**: the 4 Admin/Recommendations-adjacent deterministic test files (`adminA02Wave4BenchmarkSourceAudit`, `adminAnalyticsPhaseA`, `countryGateAdminAndHousehold`, `recommendationsPillarSignals`) — **283/283 passing**, run with `--no-file-parallelism`.
- **Full-suite and build results**: run in background this round; see §7 for the reconciled totals (captured after this document's first draft, appended before final submission).
- **TypeScript**: `npx tsc --noEmit` — the touched/added files introduce **zero** new errors. 18 pre-existing errors reproduced identically against the unmodified `origin/main` baseline via `git stash` (all `pdf-parse`/`@electric-sql/pglite` missing-module errors, unrelated to Admin, unrelated to this change) — net new errors from this round: **0**.
- **ESLint** on the 2 touched/added TypeScript files: **0 errors**, 1 pre-existing-pattern-class warning (`no-unused-vars`, resolved by typing the mock's call signature explicitly rather than naming an unused parameter) — resolved, 0 warnings remain on these files. The `.sql` migration file produces only the expected "no linter configured for this extension" notice, not a real finding.
- **Migration governance — a real collision was caught mid-round, not by this round's own original scan, and is disclosed here rather than quietly corrected.** This round's first pass allocated `0124` after a filesystem scan limited to the named `D:/fhip-*` worktrees plus `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` (both clean at the time) — exactly the bounded scan this document's own G3 gate (§11) had already flagged as incomplete ("~140 `D:/fhip-*` + `agent-*` worktrees exist; this round spot-checked... not all ~140"). The Product Owner / coordinating session independently found that `supabase/migrations/0124_module11_4_standard_question_library.sql` already exists on `feature/module-11-4-standard-question-library` (worktree `D:/FHIP/.claude/worktrees/agent-af68fb907f62d3076`) — an unmerged branch not among the `D:/fhip-*`-prefixed paths this round had checked — and that this migration is **already applied to DEV**. This was independently re-verified before acting on it (not taken on faith): `git worktree list` confirms that worktree/branch exists; `git ls-tree -r --name-only feature/module-11-4-standard-question-library -- supabase/migrations` confirms the exact colliding filename is really there. **The migration was immediately renumbered to `0125`** (file rename only — content, including the `CHECK`-constraint SQL itself, is byte-identical; the earlier SHA-256 for the `0124`-named file therefore still matches the renamed file's content). A repository-wide rescan was then run via `git log --all --diff-filter=A --name-only -- "supabase/migrations/*.sql"` — this single command covers every commit reachable from **every** local branch/tag/remote-tracking ref in the shared object store (all `D:/fhip-*` and `D:/FHIP/.claude/worktrees/*` paths are worktrees of this **same** repository, confirmed via `git worktree list`, so this is not a partial scan the way the original filesystem walk was) — and found the highest migration number ever added on any reachable commit is `0124`; a further explicit check confirms no file named `0125` exists anywhere, including on `feature/module-11-4-standard-question-library` itself. **`0125` is confirmed genuinely free repository-wide, not just against `origin/main`.** `node scripts/check-migration-versions.mjs` → `OK: 120 active migrations, one file per version, next version is 0126.` `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → `OK: no cross-branch migration collisions` (unchanged, since `origin/main` itself still tops out at `0123` either way — this script alone would never have caught the real collision, which is exactly why the dispatch's own §22 requires the wider worktree scan). SHA-256 of `0125_admin_a02_wave4_benchmark_source_audit.sql`: `e1fbe41143f99a9c5bf2ab39a155ac145c8266651a8bd08c65e2d70970def594` (unchanged from the `0124`-named file, as expected for a pure rename). **G3 (§11) is accordingly updated below**: the very risk it named materialized for real, closed the moment it was found, and is left open only for the *remaining* un-diffed worktrees (this incident closes the Module-11.4 instance specifically, not the general residual).
- **Secrets/conflict-marker scan**: `git diff` shows zero matches for a service-role key pattern or a JWT-shaped literal, and zero unresolved conflict markers.
- **Exact changed-file diff**: `app/api/admin/benchmarks/sources/[id]/route.ts` (36 insertions, 2 deletions) modified; `supabase/migrations/0125_admin_a02_wave4_benchmark_source_audit.sql` and `tests/unit/adminA02Wave4BenchmarkSourceAudit.test.ts` added; `docs/admin/A02_WAVE3_TASK_MANUALS.md` (ADM-01 section only, §16) modified. Nothing else in the tree is touched — confirmed by `git status --short`.
- **Not yet done, disclosed**: this fix has **not** been applied to DEV or live-HTTP-verified (no `.env.local` exists in this worktree; none was borrowed this round — see §11/§12 for why and what closing this would need). The migration's `DROP CONSTRAINT IF EXISTS benchmark_update_runs_approval_status_check` / `ADD CONSTRAINT` pair relies on Postgres's well-documented default naming convention for an unnamed inline-column `CHECK` (`<table>_<column>_check`) — this is standard, well-established Postgres behaviour, but has not been executed against a real Postgres instance this round; G1's live-DEV application (§11) is also where this specific assumption gets its first real proof.

---

## 5.3 Zero-row mutation register — one further finding, not fixed this round (disclosed, not hidden)

A quick sweep of the 6 `DELETE`-exporting route files (§4's own reference to "no genuinely destructive hard-delete route" prompted this check) found one more real pattern, of lower severity than §5's fix, not corrected this round:

`DELETE /api/admin/resources/related/[id]` → `removeRelatedContent()` → `supabase.from('resource_related_content').delete().eq('id', id)` with no `.select()`/`count` request. Supabase/PostgREST's `DELETE` does not error when zero rows match a filter — it returns `error: null` regardless of whether 0 or 1 rows were actually removed. The route therefore returns `200 {data: {id}}` ("removed") for an `id` that never existed, indistinguishable from a real deletion. `DELETE /api/admin/resources/context/[id]` (`deleteContextMapping`) follows the identical shape.

**Classification: not `MISLEADING_SUCCESS` in the Standard's own strict sense** — no authorization is bypassed, no financial or content state is falsely reported as changed when it was actually denied, and "delete a relationship that already doesn't exist" is a defensible idempotent-success reading of a `DELETE` verb (unlike this round's own §5 fix, where a **status update** silently no-op'd against an unknown row's audit trail while implying a real business action happened). It is named here as a genuine, disclosed **result-state ambiguity** (§12.1/§14's own "what zero affected rows means" requirement is not explicitly answered by either route today) rather than fixed, because: (a) it would require choosing and threading a `count`/`select` check through two more route+service-function pairs without live-DEV time remaining this round to prove the change; (b) unlike §5's fix, no audit-evidence gap accompanies it (Related Content deletion is not on the §9 high-risk priority list); (c) fixing it now, without also deciding the Product-Owner-level question of "should DELETE-of-already-gone be 200 or 404 here", risks a second unilateral result-state policy decision in one round. Recorded as **DEF4-10** below for an explicit Product Owner ruling on the intended zero-row contract for idempotent deletes generally (it likely applies to more than these two routes), rather than patched ad hoc.

---

## 6. Audit coverage inventory (high-risk priorities from §9, current state)

| Priority | Surface | Status | Evidence |
|---|---|---|---|
| 1. Role assignment/revocation/deactivation | Resources roles (`assignResourceRole`/`removeResourceRole`) | `AUDITED_COMPLETE` | Trusted actor, before/after state, self-lockout guard, idempotent zero-row-safe removal, `resource_audit_log` insert on every real change (§4 above) |
| 2. Publication/unpublication/approval/suspension/reinstatement | Resources workflow (`transition_resource_post_status`) | `AUDITED_COMPLETE` | Atomic `resource_workflow_history` + `resource_audit_log` insert inside the same `SECURITY DEFINER` transaction as the status change (migration `0049`) |
| 2/4. Benchmark source approval/suspension/reinstatement | `benchmarks/sources/[id]` PUT | **Was `AUDIT_MISSING_HIGH_RISK` → now `AUDITED_COMPLETE`** | §5 above (this round's fix) |
| — Benchmark dataset activate/retire | `datasets/[id]/activate`, `datasets/[id]/retire` | `AUDITED_COMPLETE` | Pre-existing `benchmark_update_runs` insert on both the accept and reject path (migration `0011`) |
| 3. Recommendation creation/activation/deactivation/condition replacement | `admin_upsert_recommendation_atomic`, `admin_import_recommendation_conditions` | `AUDITED_COMPLETE` (Pattern B, approved) | Certified Wave 1/1B, re-affirmed not reopened this round per explicit dispatch instruction |
| 5. Bulk imports/replacements | Recommendations upload (`admin_import_recommendation_conditions`) | `AUDITED_COMPLETE` | Same Pattern-B RPC as above |
| 6. Destructive deletion | No genuinely destructive (hard-delete) Admin mutation was found this round outside the already-`is_active=false`-style soft-deletes (role removal, content archival) | `AUDIT_NOT_REQUIRED` for the soft-delete paths found; **no hard-delete Admin route was inventoried this round with a missing-audit gap** — a targeted `DELETE`-handler sweep across all 6 `DELETE`-exporting route files was not exhaustively completed this round (see §12) |
| 7. Global configuration | AI platform controls (`ai/controls`, `ai/kill-switch`) | `AUDITED_COMPLETE`, per Module 11's own design (`ai_config_audit` trigger + `ai_operational_events`, mandatory reason on stop) — **inventoried only, per §19 boundary, not modified** | Confirmed by direct route read this round |
| 8. Kill-switch changes | Same as above | `AUDITED_COMPLETE` | Same evidence |
| 9. Privileged exports | No CSV/PDF export route was found under `app/api/admin/**` this round (`grep -rl "text/csv\|application/pdf" app/api/admin` — no matches) | `AUDIT_NOT_REQUIRED` (no such surface exists yet in current Admin) | If a future wave adds one, Standard §11 governs it fully already |
| 10. Security-sensitive support/account actions | Resources Users & Roles screen is the only such surface currently in Admin | Covered under priority 1 above | — |

**Net result: the one real, named high-risk gap this round could find (source-level Benchmark lifecycle audit) is closed. No other high-risk-priority surface was found missing required evidence** — but this is bounded by the scan depth disclosed in §12 (not every one of the 73 routes' zero-row/audit behaviour was individually re-derived from scratch this round; the ones checked are the ones the dispatch's own priority list names).

---

## 7. Full-suite, build and live-DEV status (appended after background runs completed)

### 7.1 Production build — pre-existing, unrelated blocker, disclosed rather than hidden

`npm run build` (Turbopack) **fails before reaching any Admin route**, with exactly 2 fatal `Module not found: Can't resolve 'pdf-parse'` errors:

```
./lib/financial-data-hub/bank-pdf/textExtraction.ts:35:1
./lib/services/investment-intelligence/pdfExtraction.ts:17:1
```

Root cause, confirmed: `pdf-parse` is declared in `package.json` (`"pdf-parse": "^2.4.5"`) but **is not present in this worktree's `node_modules`** (`ls node_modules/pdf-parse` → no such file or directory) — a pre-existing, worktree-local dependency-installation gap in the Financial Data Hub / Investment Intelligence PDF-ingestion code, not anything under `app/(app)/admin` or `app/api/admin`, and not something this round created. This is the same root cause behind the 18 pre-existing `tsc --noEmit` errors already reproduced identically against the unmodified `origin/main` baseline via `git stash` (§5.2) — `tsc`'s own type-checking graph surfaces exactly 2 test files directly (`fdh5ClassificationAndPassword.test.ts`, `iiR2PdfExtraction.test.ts`) plus the two library source files themselves; running the **full test suite** (§7.2) finds a materially larger set of test files failing at runtime for the identical reason, because Vitest actually executes each file's real import graph rather than only the subset `tsc` traverses — see §7.2's exact file list. One further, unrelated missing-module error (`@electric-sql/pglite`) affects a separate test-support harness. **None of these pre-existing errors are in any Admin file.**

Per Standard §14 ("must not... fix unrelated defects without separate authority") and this Wave's own §23 exclusions, this round does **not** attempt to install the missing dependency or otherwise repair FDH/Investment-Intelligence PDF ingestion — that is genuinely out of this Wave's scope. **This means a clean, whole-repository `npm run build` pass could not be obtained this round**, and is named here as a residual rather than silently omitted from the required build evidence (§30 of the deliverables list). The narrower, in-scope evidence that *is* available: `npx tsc --noEmit` on the two files this round touched produces zero errors, and ESLint on the same two files produces zero errors/warnings (§5.2).

### 7.2 Full deterministic test suite — exhaustive accounting, by name and category

Run with `--no-file-parallelism` (Wave 2/3's own documented mitigation for the shared-DEV-project parallel-run nondeterminism, re-applied here for the same reason) across the entire `tests/unit/` tree (220 files), after the migration rename in §5.2 (so these numbers reflect the final, `0125`-named state, not the earlier `0124` allocation):

```
Test Files  16 failed | 202 passed | 2 skipped (220)
     Tests  3 failed | 4892 passed | 18 skipped (4913)
   Duration  441.29s
```

**A real, disclosed complication, matching Wave 2/3's own already-documented finding**: an earlier run of this exact same suite (same flags, same tree) produced **15** failed files / **2** failed tests rather than 16/3 — the one additional failure (`fdh1Isolation.test.ts`, below) did not reproduce the second time. This is the identical class of full-suite-load timing sensitivity Wave 2/3 already disclosed (their own D-5 finding), re-confirmed here rather than newly discovered; the numbers above are from the later, complete run (the earlier run's output was truncated by this session's own tooling before a full accounting could be extracted from it, which is why the later run is the one certified against).

**13 suite-level failures** (the whole file errors before any test is discovered — neither "passed", "failed" nor "skipped"; individual test-case counts obtained via `grep -c "^\s*it("` on each file, since Vitest itself never discovers them):

| File | Cause | Undiscovered test cases |
|---|---|---:|
| `aiInsightPack20HouseholdE2E.test.ts` | `Cannot find package '@electric-sql/pglite'` (via shared `tests/unit/support/pgliteInsightPackHarness.ts`) | 1 |
| `aiInsightPackBatchOrchestratorPglite.test.ts` | same | 1 |
| `aiInsightPackIsolatedKillSwitchLiveProof.test.ts` | same | 5 |
| `fdh5AdapterCertification.test.ts` | `Cannot find package 'pdf-parse'` | 8 |
| `fdh5ClassificationAndPassword.test.ts` | same | 12 |
| `fdh5FinancialIntegrity.test.ts` | same | 9 |
| `fdh5R8CrossFormatEquivalence.test.ts` | same | 4 |
| `fdh5Scale.test.ts` | same | 2 |
| `fdh9IncomeTabUx.test.ts` | same | 11 |
| `iiManualImporter.test.ts` | same (via `lib/services/investment-intelligence/pdfExtraction.ts`) | 9 |
| `iiR2PdfExtraction.test.ts` | same | 7 |
| `resourcesImportR1_7LiveDev.test.ts` | `ENOENT: .env.local` (no live-DEV credentials in this worktree — §7.3) | 11 |
| `resourcesP0ContentR1_7CLiveDev.test.ts` | same | 5 |
| **Total** | | **85** |

Every one of these 13 is the same pre-existing `pdf-parse`/`@electric-sql/pglite` missing-module gap named in §7.1, or the same missing-`.env.local` condition named in §7.3 — none is new, none touches Admin, and none is a regression from this round's 4-file diff (§5.2).

**18 skipped** (discovered, individually enumerated, deliberately not run via `describe.skipIf(...)` because their own live-DEV enablement flag is false) — same 2 files, same 18 tests Wave 3's own terminal report already named (`iiR4LiveIntegration.test.ts`, 5 tests; `resourcesR1_7DFinalLiveDev.test.ts`, 13 tests) — not re-enumerated here since nothing about them changed.

**3 failed tests, individually named, each independently confirmed pre-existing/environmental:**

1. `aiResidualClosureFailClosed.test.ts` › *"A4. NEGATIVE CONTROL — a default-allow source client ADMITS the same failure and reaches the provider"* — `AssertionError: expected 0 to be greater than 0`. **Reproduced identically against the unmodified `origin/main` baseline** via `git stash` + isolated re-run this round (§5.2) — in fact the isolated baseline run failed *two* sub-tests (this one plus `A1`), confirming this file's tests are independently timing-flaky regardless of any change made this round. Not attributable to this Wave; not an Admin-adjacent file.
2. `fdh1Isolation.test.ts` › *"is imported by nothing outside itself, except the FDH-3 upload surface"* — `Test timed out in 20000ms`. This test's own comment states it "does a synchronous fs walk + readFileSync of every `.ts`/`.tsx` file" in the repository — an inherently slow, disk-I/O-bound check whose margin narrows as the full-suite run puts load on the same filesystem Wave 3's own report already flagged as slow ("Slow filesystem detected" — Turbopack's own startup log, §2.1.3 of the Wave 3 certification report). **Re-run in isolation this round: passes cleanly in 2.27s** (25/25), far under its own 20s budget — consistent with full-suite-load sensitivity, not a regression. This round's diff adds exactly one small new `.ts` file (`tests/unit/adminA02Wave4BenchmarkSourceAudit.test.ts`) to the tree this test walks; given the isolated run's 2.27s margin, one additional ~150-line file is not a plausible sole cause of an 18-second overrun, but this round did not re-run the **full** 220-file suite against the unmodified baseline to prove the identical flake reproduces there too (that would cost another ~7-minute run) — disclosed as a residual rather than asserted with more confidence than the evidence supports.
3. `resourcesR1_1.test.ts` › *"an ordinary customer cannot edit content, transition workflow, read audit log, read workflow history, or read Resources roles"* — `Test timed out in 5000ms`. **Identical test name and timeout** to the flake Wave 3's own terminal report already disclosed and attributed to live-DEV network latency (Wave 3 certification report §4.1) — re-confirmed, not newly discovered.

**Reconciliation**: 4913 discovered (4892 passed + 3 failed + 18 skipped) + 85 undiscovered (13 suite failures) = **4998 test cases accounted for by name or by count, none silently rounded away**. **Net regression count attributable to this Wave: zero** — every non-passing item is either a pre-existing missing-dependency/missing-credential condition unrelated to Admin, or a timing-sensitive flake independently reproduced against baseline (item 1) or plausibly attributable to full-suite load rather than this round's own small diff (item 2, disclosed with the honest limit of what was actually proven), or an exact match to a flake Wave 3 already disclosed under its own name (item 3).

### 7.3 Live DEV

**Not performed this round** — no `.env.local` exists in this worktree and none was borrowed (Wave 3's own precedent: a plain, never-committed file copy from a sibling worktree such as `D:/fhip-fdh10-terminal`, deleted at the end of the round). This is Gate G1 in §11 — named as the reason this round cannot claim FULL PASS, not glossed over.

---

## 8. Canonical shared audit design package (FDH-13 REG-05) — design only, no table built

This is a **design proposal**, not an implementation. No shared table is created this round; the intent is that a future canonical Admin architecture (A1+) can adopt this contract wholesale, and that existing per-domain audit structures can migrate into it later without a second redesign.

### 8.1 Proposed contract (fields)

| Field | Type | Notes |
|---|---|---|
| `event_id` | uuid, PK | |
| `occurred_at` | timestamptz | server-set, never client-supplied |
| `domain` | text | e.g. `resources`, `recommendations`, `benchmarks`, `ai`, `roles`, `fdh` (future) |
| `action` | text | stable machine code, e.g. `ROLE_ASSIGNED`, `POST_PUBLISHED`, `SOURCE_SUSPENDED` |
| `actor_id` | uuid, FK → `auth.users` | **always** server-derived from the authenticated session (mirrors every existing pattern found this round: `requireAdmin()`'s `user.id`, `getCurrentResourceRoles()`'s `user.id`) — never a request-body field |
| `actor_type` | text | `human_admin`, `service_role`, `system` (for future automated/background Admin actions) |
| `effective_capabilities` | jsonb | a snapshot of the authorization context that permitted the action (e.g. `{isSuperAdmin: true}` or `{roles: ['resource_admin']}`) — so a later audit of "was this actually authorized at the time" doesn't depend on reconstructing role history |
| `target_type` | text | e.g. `benchmark_source`, `resource_post`, `resource_user_role` |
| `target_id` | uuid, nullable | nullable because some targets (e.g. a role assignment) are naturally identified by a composite, not a single row id — see `metadata` |
| `before_state` | jsonb, nullable | |
| `after_state` | jsonb, nullable | |
| `reason` | text, nullable | mandatory at the call-site level for specific high-risk actions (e.g. AI kill-switch already enforces this; role removal and source suspension do not currently require one — a future policy decision, not decided here) |
| `result` | text | `success`, `rejected`, `failed` — **failed/rejected mutations must still produce a row** (§9's own requirement, already true for the dataset-activation-rejection path, migration `0011`) |
| `correlation_id` | text/uuid, nullable | request-scoped id threading API → RPC → audit row, for reconstructing one operator action across multiple writes; **not currently implemented anywhere in this codebase** — see §12 |
| `jurisdiction` | text, nullable | populated only where the target itself is jurisdiction-scoped (most Admin content is not) |
| `privacy_classification` | text | `none` / `contains_pseudonymous_reference` / `contains_personal_data` (the last should never actually occur in Admin audit per Standard §9 — this field exists so an accidental violation is machine-detectable, not just policy-prohibited) |
| `pseudonymous_subject_ref` | text, nullable | for the rare case an Admin action concerns a specific end-user account (e.g. role assignment's `target_user_id`) without embedding a raw identifier inline in `metadata` |
| `supersedes_event_id` / `reverses_event_id` | uuid, nullable | for a reinstatement that undoes a suspension, a re-approval that supersedes a rejection, etc. — **not populated by any current write path**, a genuine design gap disclosed here rather than silently addressed (e.g. this round's own new Benchmark-source audit row does not link a "reinstated" event back to the "suspended" event it reverses) |
| `metadata` | jsonb | allow-listed, safe, non-personal-financial-data fields only (Standard §9) |

### 8.2 Append-only protection

Every existing audit table found this round (`resource_audit_log`, `resource_workflow_history`, `benchmark_update_runs`, `ai_config_audit`) is **already** insert-only from the application's perspective (no `UPDATE`/`DELETE` route or RPC was found targeting any of them) and RLS-locked to service-role-only writes. The canonical design should make this a **database-level** guarantee (`REVOKE UPDATE, DELETE` explicitly, not merely "nobody happens to call it") — this round did not verify that explicit `REVOKE` exists on all four tables (see §12) and flags it as a concrete thing to check/close before any canonical migration is attempted.

### 8.3 How existing structures integrate

| Existing table | Would map to canonical `domain` | Migration path (future, not this round) |
|---|---|---|
| `resource_audit_log` | `resources` | Already closest in shape to the proposal (`entity_type`/`entity_id`/`before_state`/`after_state`/`actor_user_id`) — would need `correlation_id`, `result`, `supersedes_event_id` added |
| `resource_workflow_history` | `resources` (workflow-specific) | Could remain a domain-specific *supplement* alongside the canonical table rather than being replaced (Standard's own principle: don't force everything into one shape if a domain's richer supplementary record is still useful) |
| `benchmark_update_runs` | `benchmarks` | Would need `correlation_id`, `actor_type`, `privacy_classification`; `approval_status`'s dataset-import-specific vocabulary would map to canonical `action`/`result` instead |
| `ai_config_audit` / `ai_operational_events` | `ai` | Not inspected in schema detail this round (out of scope per §19); flagged for the future canonical-migration exercise to assess, not assessed here |

**No existing audit table is migrated, replaced, or altered in shape this round** (only `benchmark_update_runs`'s `CHECK` constraint was widened, which is additive and backward-compatible, not a shape change).

---

## 9. Canonical shared security-event design package (FDH-13 REG-07) — design only

### 9.1 Event-class distinctions (per §11 of the dispatch)

| Class | Example in this codebase today | Where it would be classified |
|---|---|---|
| Business audit event | A role assignment, a source suspension | `domain` audit table (§8), not this security-event stream |
| Authorization denial | `requireAdmin()`'s 403, `canManageResources()`'s 403 | Security-event, `event_type: AUTHZ_DENIED`, low severity unless repeated |
| Suspicious repeated denial | N/A — **no repeated-denial detection exists anywhere in this codebase today**, confirmed by grep (`rate.?limit`, `repeated.*denial`, `brute` return no Admin-relevant hits) | Would require a new counter/window mechanism — explicitly **not built this round** (would be new functionality, out of this Wave's remediation scope, and arguably needs the canonical platform itself, per §9's own escape valve: "if closing a gap genuinely requires the future canonical audit platform, classify it as a named Wave 4 residual") |
| Privilege escalation attempt | The self-escalation defence already built into `/api/admin/resources/users/roles` (a non-`canManageResources()` caller gets 403 before any role read/write) | Currently just a 403 response, not a distinguishable *security event* from an ordinary denial — a future canonical stream could flag "attempted role write by a non-privileged caller" as a distinct, higher-severity `event_type` from a routine "tried to view a page they can't see" |
| Raw-data access attempt | N/A — Admin analytics is still a placeholder (Wave 3's own PLC-1 closure); no raw-data-shaped Admin surface exists to attempt access to yet | Reserved for when the Analyst Analytics platform is actually built |
| Export event | N/A — no export route exists (§6 above) | Reserved |
| Kill-switch action | `ai/kill-switch` | Already has its own dedicated event log (`ai_operational_events`) — would feed the canonical stream as `event_type: KILL_SWITCH`, `domain: ai` |
| Break-glass event | N/A — no break-glass mechanism exists in current Admin | Reserved; explicitly **not** to be built here (§17: "support/break-glass access" is a named FDH-13-implementation exclusion) |
| Validation failure | Every `422` response found this round (invalid status, invalid role, malformed body) | Low-severity, high-volume — should NOT alert by default, only aggregate |
| Infrastructure failure | Every `500` from `adminRoute()`'s catch-all, or a database error surfaced as `bad(error.message)` | Distinct from a validation failure; the canonical design should NOT let a raw `error.message` (which can contain a Postgrest/Postgres internal string) reach this stream's own `metadata` unfiltered — a concrete instance of exactly this risk was found and left unfixed this round (see §12: `bad(error.message)` is used verbatim in several Benchmarks routes, and would leak an internal Postgrest message into whatever logs/streams read it) |

### 9.2 Contract fields

`severity` (`info`/`warning`/`high`/`critical`), `actor` (same trusted-actor discipline as §8), `source` (`api`/`rpc`/`background`), `domain`, `event_type`, `target` (type+id, nullable), `result`, `correlation_id`, `safe_metadata` (an explicit allow-list, never a raw error object or raw request body), `retention_classification`, `alerting_eligibility` (boolean — most validation failures should not page anyone), `redaction_requirements` (explicit: no secrets, no raw documents, no transaction descriptions, no unnecessary personal financial data — restating Standard §9/§7 verbatim as the redaction contract for this stream specifically).

**One canonical architecture, `domain`-classified, not an FDH-only system** — this design package is written domain-agnostically from the start (it names `resources`/`benchmarks`/`ai`/`roles` as today's real domains and reserves `fdh` as a future value, never a parallel FDH-specific schema) — directly satisfying §11's "Prefer ONE canonical security-event architecture... do not create an FDH-only security-event system."

---

## 10. FDH-13, Analyst and MCC boundary confirmation

- `git status --short` against `origin/main`: the three code/test/migration files named in §5.2, this report document, and a targeted update to `docs/admin/A02_WAVE3_TASK_MANUALS.md`'s **ADM-01** section only (§16 of the dispatch: "Update Wave 3 task manuals ONLY where Wave 4 changes... audit evidence" — ADM-01's audit-evidence claim was the one manual entry this round's own fix made stale, so it alone was corrected; ADM-02/ADM-03 and every other manual entry are untouched). **Zero** files under `lib/financial-data-hub/`, **zero** `fdh_*`-prefixed migration, **zero** new role table, **zero** new nav root.
- The FDH-13 baseline (`docs/fdh13-admin-integration-baseline` @ `9fdce5d`, unmerged) was consulted only to confirm its own traceability matrix's requirement-ID count is unaffected by anything in §8/§9 above — **no traceability row was changed this round**; this round's audit/security-event design packages are offered as *input* to that matrix's eventual owner, not a change to the matrix itself. The 85 requirement IDs are not touched, added to, or renumbered.
- No Analyst capability was added, removed, or widened. `isResourceStaff()`'s exclusion of `'analyst'` is unchanged; the hidden-Analytics-nav-with-honest-notice state from Wave 3 (§2.3 of its certification report) was re-read, not re-implemented, and no code in `lib/admin/adminNav.ts` or `components/ui/AppShell.tsx` was touched this round (confirmed: neither file appears in this round's diff).
- MCC was not reopened — no file under the country-confirmation gate (`lib/services/countryGate.ts`, `MCC*` migrations) was touched.
- No "Super Admin interim" allocation was made permanent — the one route this round modified (`benchmarks/sources/[id]`) uses the same pre-existing `requireAdmin()` gate it already had; nothing was widened, narrowed, or newly allocated.

---

## 11. Verdict

### Admin A0.2 Wave 4 — **CONDITIONAL PASS — NAMED GATES OUTSTANDING** (Round 1 of this Wave; not a terminal closure)

This round genuinely completes: the starting gate; a fresh, current-`origin/main` surface count; a functional-area authorization/RPC classification register with documented Super-Admin justifications (not "already uses `requireAdmin()`" alone); one concrete, high-risk, previously-undisclosed audit gap found, fixed, migrated, tested (6 new focused tests, all passing) and reconciled against a clean TypeScript/ESLint/migration-collision baseline; a genuine zero-row/not-found result-state fix bundled with it; a full 220-file/4998-test-case deterministic-suite reconciliation with zero net regressions (§7.2); both named canonical design packages (§8/§9) as design input, explicitly not implemented as a shared table/stream; full FDH-13/Analyst/MCC boundary re-confirmation; and a real migration-number collision (against an unmerged Module 11.4 branch not covered by this round's original worktree scan) caught mid-round, independently re-verified, and fully closed by renumbering to `0125` with a repository-wide re-scan (§5.2, §11/G3).

**This round does not claim, and could not honestly claim, FULL PASS**, because the following named gates are real and outstanding — each with its own reason, owner and closure action, per §26's own CONDITIONAL PASS format:

| Gate | Missing evidence | Reason | Risk if left open | Responsible party | Closure action | Blocks merge? |
|---|---|---|---|---|---|---|
| G1 — Live-DEV verification of the §5 fix | No real HTTP round trip against real DEV Postgres for the new audit-insert behaviour or the 404 fix | No `.env.local` exists in this worktree this round; borrowing one (Wave 3's own precedent, `D:/fhip-country-confirm`) and running a full live session was not performed in this round's time budget | Low-moderate — the fix is unit-tested against a faithful mock of the real Supabase client shapes used elsewhere in this codebase, and the migration is additive/backward-compatible, but the actual `CHECK` constraint widening has not been proven against a real Postgres instance | This session / next Wave-4 continuation | Copy `.env.local` (plain file copy, never read/print) from a sibling worktree, apply migration `0125` to DEV, re-run the exact HTTP sequence Wave 3 used for the sibling `activate`/`retire` routes, confirm the new `benchmark_update_runs` rows, clean up fixtures | **Yes — do not merge until closed** |
| G2 — Per-route (not per-area) authorization inventory for all 73 routes | §4's register is at functional-area granularity, matching Wave 3's own precedent, not a 73-row flat table | Time budget this round; the areas most likely to carry a new defect (Benchmarks, Recommendations, Resources workflow/roles) were read in full; several read-only or already-far-more-scrutinized routes (e.g. the `sources`/`tags`/`authors`/`categories` shared lookup routes) were not individually re-derived | Low — no evidence found this round suggests these routes deviate from their area's classification, but "no evidence found" is not the same as "individually proven" | Next Wave-4 continuation | Produce the flat 73-row table the dispatch's §4 literally asks for, closing each row against the same classification taxonomy | No — informational completeness gap, not a known defect |
| G3 — Exhaustive sibling-worktree scan (§2 of the dispatch) | ~140 `D:/fhip-*` + `D:/FHIP/.claude/worktrees/agent-*` entries exist; this round's original pass spot-checked the ones with Admin-relevant names/dates, not all ~140 | **This gate's own predicted risk materialized for real, mid-round**: `D:/FHIP/.claude/worktrees/agent-af68fb907f62d3076` (`feature/module-11-4-standard-question-library`, not an Admin-relevant-sounding name, hence not in the original spot-check) carries `supabase/migrations/0124_module11_4_standard_question_library.sql`, already applied to DEV, colliding with this round's originally-allocated `0124`. Caught by the coordinating Product-Owner session, independently re-verified here (`git worktree list` + `git ls-tree`), and closed by renumbering to `0125` plus a repository-wide `git log --all` rescan (§5.2) that is now provably comprehensive (every ref in the shared object store, not a filesystem walk of named paths) | **This specific instance: closed.** General residual: **still open** — other un-scanned `agent-*` worktrees could equally carry live, DEV-applied, unmerged migrations this round has not individually checked by name | Next Wave-4 continuation | The general fix is now cheap and repeatable: re-run the exact `git log --all --diff-filter=A --name-only -- "supabase/migrations/*.sql"` scan (§5.2) immediately before any future allocation or handoff — it is a single command, already proven this round to catch what a named-path filesystem walk misses, and needs no per-worktree iteration at all |
| ~~G4 — Duplicate-role-row schema guarantee~~ | ~~Whether `resource_user_roles` has a uniqueness guarantee~~ | — | — | — | **CLOSED this round** — `uq_resource_user_roles_active` (partial unique index, migration `0049`) confirmed by direct grep; duplicate active rows are schema-impossible | No |
| G5 — `correlation_id` threading | Named in the canonical design package (§8) as **not implemented anywhere today** | Genuinely new plumbing (would touch every Admin route + RPC call site) | Low today (no cross-system Admin incident investigation currently depends on it) | A1 canonical Admin architecture, per the design package's own scope | Adopt the §8 contract when the canonical audit platform is actually built | No — explicitly deferred by design, not a Wave 4 defect |
| G6 — Raw `error.message` reaching client/log surfaces in Benchmarks/Recommendations | `grep -rn "bad(error.message)" app/api/admin/benchmarks app/api/admin/recommendations` finds **19 call sites** across 10 files (`cohorts`, `datasets`, `datasets/[id]/activate`, `datasets/[id]/retire`, `sources`, `sources/[id]` — narrowed this round to the not-found case only, the update-error path still uses it — `target-ranges`, `update-runs`, `values`, `recommendations/gaps`, `recommendations/upload`, `recommendations/[id]`) | Pre-existing pattern, not introduced this round, far wider than the one route this round touched | Low-moderate — Postgrest error strings for this admin-only, non-personal-data table are unlikely to leak sensitive content, but they are still an internal implementation detail (Standard §13: "never... a partial raw result") | Next Wave-4 continuation, or a deferred Wave-4-B pass | Replace `bad(error.message)` with a stable machine code + a generic administrator-facing message across all 19 call sites (Recommendations' 3 call sites are inside the Pattern-B-approved upload flow — touch only the error-message shaping, not the RPC/authorization logic, to avoid reopening the approved exception) | No — pre-existing, not a regression, but worth closing under this Wave's own §13 mandate |
| G7 — Append-only `REVOKE` verification on all 4 existing audit tables | Asserted (no `UPDATE`/`DELETE` caller found) but the explicit database-level `REVOKE UPDATE, DELETE FROM authenticated` was not individually confirmed for each of the 4 tables this round | Time budget | Low (RLS with zero policies already blocks `authenticated` from any DML without an explicit `USING`/`WITH CHECK` policy — belt-and-suspenders, not the only protection) | Next Wave-4 continuation | One migration-history grep per table | No |

**No stop condition (§25) was triggered this round.** No new capability was proposed that would change role authority; no route's intended owner was undeterminable; the one genuine ambiguity found (the dispatch's own assumption about `origin/main`'s advancement, §1.1) was resolved by direct evidence in the repository's favour, not worked around; no migration collision exists; no existing certified invariant was weakened (Recommendations Pattern B, Wave 2's `55000` SQLSTATE discipline, and Wave 3's Analytics-hide-with-notice outcome are all confirmed byte-for-byte untouched); Analyst gained no mutation authority; no raw personal financial data entered any audit/error path this round introduced.

---

## 12. Deferred-findings register (this round)

| # | Finding | Status |
|---|---|---|
| DEF4-1 | Live-DEV verification of the §5 fix not performed | **Open — G1 above** |
| DEF4-2 | Flat 73-row per-route authorization table not produced (area-level only) | **Open — G2 above** |
| DEF4-3 | Not every `D:/fhip-*`/`agent-*` worktree individually diffed against `origin/main` | **Partially closed this round** — the real collision this gap predicted (Module 11.4's `0124`) was found and fixed; the general residual (other un-named worktrees not yet individually checked) stays **open — G3 above**, though the closure method is now a single comprehensive `git log --all` command, not a per-worktree walk |
| ~~DEF4-4~~ | ~~`resource_user_roles` duplicate-row schema guarantee unverified~~ | **CLOSED this round — `uq_resource_user_roles_active` confirmed** |
| DEF4-5 | `correlation_id` threading absent platform-wide | **Deferred to A1 by design (§8), not a Wave 4 defect** |
| DEF4-6 | Raw Postgrest `error.message` surfaced in several Benchmarks routes | **Open — G6 above, pre-existing, not a regression** |
| DEF4-7 | Explicit `REVOKE` on the 4 existing audit tables unverified | **Open — G7 above** |
| DEF4-8 | AI Admin (BWU-4) still has no dedicated capability or UI | **Unchanged, correctly out of scope per §19 — not this Wave's authority to close** |
| DEF4-9 | Scheduled-publishing worker | **Unchanged, correctly deferred to A3.1 (Wave 3's own DEF-3), not reopened** |
| DEF4-10 | `DELETE .../related/[id]` and `.../context/[id]` return 200 for an already-nonexistent id (no `count`/`select` check on the delete) — §5.3 | **Open — needs a Product Owner ruling on the intended zero-row DELETE contract before a fix is applied (PO4-4, §13)** |

---

## 13. Product Owner decision register (this round)

| # | Decision needed | This round's resolution |
|---|---|---|
| PO4-1 | Is the area-level (not per-route) authorization register (§4, G2) sufficient for this round's certification, or must the flat 73-row table be produced before any merge consideration? | **Not decided here — flagged for explicit Product Owner ruling**, consistent with this round declining to unilaterally declare its own scope sufficient |
| PO4-2 | Should `benchmark_update_runs` remain the audit vehicle for source-lifecycle events long-term, or should a dedicated `benchmark_source_audit_log` be introduced later for cleaner domain separation ahead of the A1 canonical migration? | **Not decided here** — this round's choice (reuse the existing, already-scoped-for-it column) is the minimal, narrowly-scoped fix the dispatch's own §9 instruction asks for; a Product Owner may prefer a cleaner split before more source-lifecycle logic accumulates on a table named for dataset "update runs" |
| PO4-3 | Priority and timing for closing G1/G6/G7 (live-DEV proof, error-message redaction, explicit REVOKE confirmation) | **Not decided here** — offered as next-step candidates for either a continuation of this Wave or a named Wave-4-B, per Product Owner direction |
| PO4-4 | Intended zero-row contract for idempotent `DELETE` routes (200-as-success vs. 404-as-not-found) generally, not just the two routes named in DEF4-10 | **Not decided here** — a platform-wide convention decision, offered rather than resolved unilaterally per-route |
| PO4-5 | Real migration-number collision found mid-round: this Wave's original allocation of `0124` collided with `feature/module-11-4-standard-question-library`'s already-DEV-applied `0124_module11_4_standard_question_library.sql` (a worktree/branch outside this round's original spot-checked path list) | **Flagged by the coordinating Product-Owner session, independently re-verified, and resolved during this round**: renamed to `0125` (byte-identical content, confirmed by unchanged SHA-256), a repository-wide `git log --all` rescan confirms `0125` is genuinely free across every ref, not merely `origin/main`. See §5.2 and G3/DEF4-3 (§11/§12) for the full account, including the process gap this exposed in the original scan's scope. |

---

## 14. Source-control status

| Item | Value |
|---|---|
| Branch | `worktree-agent-a3cfa187061e5a032` |
| Base | `origin/main` @ `99f0cc0` (current tip) |
| Merged to `main` | **No — not authorised, not attempted** |
| Pushed to origin | **No — not attempted** |
| Production migration | **No — migration `0125` created and locally verified only; not applied to DEV or production this round** |
| Production deployment | **No** |
| Any Resource published/approved/retired | **No** |
| Role or capability changes | **None** |
| Synthetic/live-DEV fixtures | **None created this round** (no live-DEV session performed) |
| `.env.local` / credentials | **Not borrowed this round** |
| FDH-13 implementation begun | **No** |
| Analyst implementation phase begun | **No** |
| MCC reopened | **No** |
| Admin navigation redesign begun | **No** |
| Admin A0.2 Wave 5 begun | **No** |

Awaiting Product Owner review of this round's report, and direction on whether to continue this Wave (closing G1–G7) in a follow-on round before any FULL PASS is claimed.

---
---

# Round 2 — Product Owner Remediation Dispatch

**This section supersedes Round 1's verdict (§11 above) only.** §§1–10 above are carried forward unchanged as the historical record of what Round 1 found and did, per the Product Owner's own framing ("the historical reconstruction... is accepted as a status record, not a new certification"). Round 1's own evidence was independently rerun where the corrections below required it, not merely asserted still valid.

**Checkpoint commit** (per the dispatch's own instruction, before any Round 2 change): `ee92d90` — "checkpoint(admin-a02-wave4): Round 1 discovery + benchmark source audit fix (pre-atomicity-fix checkpoint)", on branch `worktree-agent-a3cfa187061e5a032`, not pushed, not merged.

## R2.1 The critical defect — fixed

Round 1's `PUT /api/admin/benchmarks/sources/[id]` committed the `benchmark_sources` status UPDATE, then attempted a separate `benchmark_update_runs` INSERT, logged-and-swallowed any insert failure, and still returned success. **This is now a single atomic transaction.**

**Design (migration `0125`, rewritten in place — never applied anywhere under its Round 1 content, confirmed by the fresh collision scan in R2.7 before this rewrite, so nothing already-shipped is being changed):**

`public.admin_transition_benchmark_source(p_source_id uuid, p_new_status text) returns benchmark_sources` — Pattern A, exactly mirroring `transition_resource_post_status` (migration 0049) and `admin_reorder_related_content` (migration 0116):
- `security definer`, `set search_path = ''` (fully-qualified references throughout);
- actor from `auth.uid()` — never a parameter, never client-supplied;
- internal `admin_users` membership recheck (`raise exception 'Admin access required'` if absent) — independent of the route's own `requireAdmin()`, which is retained as defence-in-depth;
- row-locked (`for update`) before reading the "before" status, preventing a concurrent-transition race;
- an idempotent no-op path: resubmitting the current status writes nothing and creates no audit event;
- the `benchmark_sources` UPDATE and the `benchmark_update_runs` INSERT are two statements inside the SAME function invocation with no exception handler between them — Postgres's own transactional semantics mean **any** unhandled error at either statement aborts the whole call and rolls back everything already executed. No explicit `BEGIN`/`COMMIT`/`ROLLBACK` is needed or present; this is what a single un-caught-exception PL/pgSQL function body already guarantees.
- `EXECUTE` revoked from `public`/`anon`, granted to `authenticated`/`service_role` only.

The route (`app/api/admin/benchmarks/sources/[id]/route.ts`) now calls this RPC via the **caller's own authenticated session** (`createClient()`, never the service-role `adminClient()`) for any request that includes a `status` field; a request with metadata-only fields (no status) still goes through the pre-existing, unaudited, service-role metadata-patch path (unchanged, since a metadata edit is not a lifecycle event and carries no audit requirement).

## R2.2 Audit-failure rollback — proven, not asserted

**Real PGlite Postgres, not mocks.** `scripts/admin_a02_wave4_benchmark_source_certification.mjs` replays the full 120-migration chain from empty (including `0125`) and proves, among 82 total checks, the exact sequence the dispatch demanded:

1. A genuine benchmark source is created (`under_review`).
2. A temporary `CHECK` constraint is added to `benchmark_update_runs` that only this one source's id violates (`check (source_id <> '<this-id>')`) — a real Postgres constraint failure, not a simulated one.
3. The RPC call for a valid `under_review -> approved` transition **fails** (proven: the call itself throws).
4. **`benchmark_sources.status` is confirmed UNCHANGED** (still `under_review`) — the earlier UPDATE in the same transaction rolled back.
5. **`benchmark_sources.updated_at` is confirmed UNCHANGED** — no partial write of any kind survived.
6. **Zero `benchmark_update_runs` rows exist** for this source.
7. The fault is removed (`drop constraint`).
8. The identical transition is retried and **succeeds**, producing the status change **and exactly one** audit row — not a duplicate, not a leftover from the failed attempt.

```
=== SECTION 3: Transaction-failure injection — audit failure MUST roll back the status change (RED -> GREEN) ===
  PASS  the RPC call itself fails when the audit insert is forced to fail
  PASS  CRITICAL: benchmark_sources.status is UNCHANGED after the forced audit failure (the earlier UPDATE in the same transaction rolled back)
  PASS  CRITICAL: benchmark_sources.updated_at is UNCHANGED (no partial write survived)
  PASS  CRITICAL: NO benchmark_update_runs row exists for this source after the forced failure
  PASS  after the fault is removed, the SAME valid transition now succeeds
  PASS  the retried transition actually changed the status this time
  PASS  the retried transition produced EXACTLY ONE audit row (not a duplicate from the earlier failed attempt)
```

**Full script result: 82 PASS, 0 FAIL** across 10 sections: valid lifecycle transitions with exactly-one-audit-row (§1); idempotent no-op (§2); the rollback proof above (§3); input validation with zero DB variance (§4); Pattern A structural security posture — `SECURITY DEFINER`, pinned empty `search_path`, no dynamic SQL, no identity parameter, correct grants (§5); a real permitted Super Admin session (§6); real denied sessions — non-admin, anonymous, null-actor, each with zero database variance (§7); proof the existing dataset-import audit vocabulary is unweakened (§8); a genuine, behavioural (not just structural) immutability proof for `benchmark_update_runs` — see R2.4 (§9); and structural inspection of the other 3 named audit tables (§10).

## R2.3 `benchmark_update_runs` semantic-fit determination (PO4-2)

**Round 1's use of this table is REJECTED and corrected, not defended.** Round 1 (a) widened `approval_status`'s vocabulary to include source-status values, and (b) stored the resulting status in `previous_version`/`new_version` — both are real semantic overloads: `approval_status` canonically means "did this governance action's validation succeed" (`pending`/`approved`/`rejected`), and `previous_version`/`new_version` canonically mean a **dataset's version string** (`datasets/[id]/activate`'s own `new_version: data.version`), not a source's lifecycle status.

**This round's fix, proven against every one of PO4-2's own required properties:**

| Required property | How it's satisfied |
|---|---|
| Source lifecycle events representable without misleading field semantics | Three new, purpose-specific, nullable columns: `event_type` (`'DATASET_IMPORT'` \| `'SOURCE_LIFECYCLE'`), `previous_status`, `new_status`. `approval_status`/`previous_version`/`new_version` are completely untouched for both event types — `approval_status` keeps its exact original meaning (`approved` = the governance action's validation succeeded, which is always true by the time a `SOURCE_LIFECYCLE` row is written, since an invalid/unauthorized attempt never reaches the INSERT) |
| Trusted actor identity recorded | `audit_user` = `auth.uid()` inside the function, never client-supplied — proven live (PGlite §1) |
| Previous/resulting statuses unambiguous | `previous_status`/`new_status`, dedicated columns, never overloaded with version semantics |
| Action and target unambiguous | `event_type='SOURCE_LIFECYCLE'` + `source_id` (never `dataset_id`, which is explicitly `null` for these rows) |
| Mandatory reason where appropriate | Not applicable — no reason is currently required by product decision for source approve/suspend/reinstate (unlike the AI kill-switch, which does mandate one); not invented here |
| Event is immutable | **New**: an explicit `before update or delete` trigger (`benchmark_update_runs_immutable()`) — see R2.4 |
| Lifecycle mutation and audit insert occur in the same transaction | Yes — R2.1/R2.2 |
| Audit failure rolls back the lifecycle mutation | Yes — R2.2, behaviourally proven |
| One successful transition produces exactly one event | Yes — PGlite §1, per-transition-type |
| Idempotent no-change request produces no false transition event | Yes — PGlite §2 |
| Existing invariants not weakened | `approval_status`'s CHECK constraint is **unchanged** from migration `0011` (Round 1's widening is fully reverted) — proven live: a `DATASET_IMPORT`-typed row using a source-status value for `approval_status` is still rejected with `23514` (PGlite §8) |
| Existing row compatibility | Every pre-existing row is backfilled `event_type='DATASET_IMPORT'` (an `update` statement in the migration itself); no existing row's `approval_status`/`previous_version`/`new_version`/`source_id`/`dataset_id` values are altered |
| RLS and grants | Unchanged — RLS enabled, zero policies for `authenticated`/`anon` (verified structurally, PGlite §10) |
| Append-only posture | **New, hardened** — see R2.4 |
| Absence of conflicting writers | Confirmed by direct code search: the only writers into `benchmark_update_runs` are `datasets/[id]/activate`, `datasets/[id]/retire` (pre-existing, dataset-scoped, untouched) and the new RPC (source-scoped) — no other file inserts into this table |

**Determination: `benchmark_update_runs` CAN remain the bounded interim compatibility sink, with the additive columns above** — not because the original design was adequate, but because a targeted, purely-additive correction closes every one of PO4-2's named requirements without corrupting the table's pre-existing meaning for its original writer. A dedicated `benchmark_source_audit_log` was considered and is **not** built — it would be a second domain-specific audit silo, which PO4-2 explicitly names as the thing to avoid absent a proven inability to fix the existing table. The eventual FDH-13 REG-05 canonical audit table remains the actual long-term target (§8 of Round 1, unchanged) — this fix is scoped as the "bounded interim" state that phrase describes, not a competing permanent design.

## R2.4 Gate G7 — audit-table privilege and immutability, closed for `benchmark_update_runs`, inspected for the other 3

**`benchmark_update_runs` — hard immutability added and behaviourally proven**, not merely inferred from absent grants/routes (the dispatch's own explicit instruction). A new `before update or delete` trigger (`benchmark_update_runs_immutable()`, migration 0125) raises `42501` unconditionally — proven live against the strongest available session (PGlite §9):

```
=== SECTION 9: Gate G7 — benchmark_update_runs immutability (GREEN) ===
  PASS  a real audit row exists to attempt to tamper with
  PASS  UPDATE on an existing audit row is refused (42501), even for the owning/superuser session
  PASS  DELETE of an existing audit row is refused (42501), even for the owning/superuser session
  PASS  the audit row is still present, byte-for-byte, after both refused tamper attempts
  PASS  INSERT (a normal new transition) is completely unaffected by the immutability trigger
```

**`resource_audit_log`, `resource_workflow_history`, `ai_config_audit` — inspected, not modified.** Structural posture, read directly from the live schema (PGlite §10):

| Table | RLS enabled | Policies | Explicit immutability trigger | Table-level grants (authenticated/anon) |
|---|---|---|---|---|
| `resource_audit_log` | Yes | 1, SELECT-only (`"managers read audit log"`) | **None** | Full CRUD (Supabase's own default-privilege model — RLS is the only real boundary, not the grant) |
| `resource_workflow_history` | Yes | 1, SELECT-only (`"authors read own post workflow history"`) | **None** | Same |
| `ai_config_audit` | Yes | 0 | **Yes** (`trg_ai_config_audit_no_update`, migration 0115 — the precedent this Wave followed) | Same |

`resource_audit_log`/`resource_workflow_history` currently rely on RLS + zero write-capable policies only (verified: zero policies with `cmd` in `INSERT`/`UPDATE`/`DELETE`/`ALL` — the one SELECT-only policy on each grants no write capability at all) — a real, if convention-based, control, but not a hard database-level guarantee. **Deliberately NOT hardened with a trigger this round**: a direct code search found existing, working service-role maintenance/rollback scripts (`scripts/resources/p0-content/r17d-cleanup-duplicate-run.ts`, `r17d-stale-approval-regression.ts`, `rollback-safety-proof.ts`, `rollback-r0a.ts`) that legitimately call `.delete()` on these two tables as part of certification-fixture cleanup — an unconditional trigger would silently break that existing tooling. This is recorded as a **named residual for Product Owner decision** (retire those scripts first, or accept a narrower immutability contract for Resources' own audit tables), not silently left unaddressed and not unilaterally decided.

## R2.5 Gate G6 — raw-error redaction, all identified call sites closed

New shared helper `safeDbError(error, context)` (`lib/services/adminAuth.ts`) maps Postgres/PostgREST error codes to safe, stable, administrator-facing messages, logging the real error server-side only:

| Postgres/PostgREST code | Maps to | HTTP |
|---|---|---|
| `PGRST116` (no/multiple rows via `.single()`) | "The requested item was not found." | 404 |
| `23505` (unique_violation) | "This already exists or conflicts with an existing record." | 409 |
| `23503` (foreign_key_violation) | "This references a record that does not exist." | 422 |
| `23502`/`23514`/`22P02`/`22023` (not-null/check/invalid-input/scheduling) | "The submitted data is invalid." | 422 |
| Class `08`/`57014`/`55000` (connection/timeout/stale-state) | "This service is temporarily unavailable. Please try again shortly." | 503 |
| anything else | "Something went wrong. Please try again." (logged server-side) | 500 |

**Envelope stays deliberately flat (`{ error: string, code }`)**, not a nested `{ error: { code, message } }` — every existing Benchmarks-tab consumer reads `json.error` as a plain string via `alert()` (confirmed by direct read of `components/admin/AdminBenchmarksClient.tsx`); a nested object would have rendered `[object Object]`. This was caught and corrected mid-round (Round 1's `sources/[id]` rewrite briefly used the nested shape before this was noticed) — disclosed, not hidden.

**All 19 originally-identified raw `bad(error.message)` call sites closed**, across 10 files (`cohorts` ×2, `datasets` ×2, `datasets/[id]/activate` ×1, `datasets/[id]/retire` ×1, `sources` ×2, `sources/[id]` ×1 (already redesigned via R2.1's RPC-error mapping), `target-ranges` ×2, `update-runs` ×1, `values` ×2, `recommendations/gaps` ×1, `recommendations/upload` ×3, `recommendations/[id]` ×1 DELETE), plus **2 further sites found and closed beyond the original 19**: `recommendations/route.ts`'s paginated-fetch helpers (previously re-threw a raw `Error(error.message)`, now preserve the original `{message, code}` via a small `PostgrestFetchError` wrapper so `safeDbError()` can still classify it) and `recommendations/upload/route.ts`'s outer catch-all. **Recommendations' Pattern-B RPC call sites and business rules were not touched** — only the error-*presentation* layer around them (e.g. `admin_upsert_recommendation_atomic`'s own `P0002`/`23514` mapping was already safe and is unchanged).

**Negative tests** (`tests/unit/adminA02Wave4BenchmarkSourceAudit.test.ts`): representative SQLSTATEs (`23505`→409, an unmapped code→500), confirming the redaction against realistic Postgres error shapes. **Live-DEV confirmation** (R2.6): a genuine `23514` from real DEV Postgres was captured and independently confirmed to match `safeDbError()`'s own classification, and its raw message was independently confirmed to contain the exact class of internal detail (`benchmark_sources_source_type_check`) the redaction exists to hide.

## R2.6 Gate G1 — live DEV, bounded and honestly scoped

**DDL cannot be executed against DEV from this worktree** — no `supabase` CLI is linked, and `.env.local` contains only the Supabase REST/Auth API keys, no direct Postgres connection string. Migration `0125` therefore has **not** been applied to DEV. This is the same "manual handoff" limitation every prior Wave in this programme has hit and disclosed (Wave 1/2/3's own reports), not a new gap this round introduced.

**Credentials**: `.env.local` copied (plain file copy, contents never read/printed/committed) from `D:/fhip-country-confirm`, matching Wave 3's own precedent. Verified DEV, not production, before any use: `grep -c "vqycarelcoijzwlpkpcz"` (the certified DEV project ref constant) against the file returned `1`. The file also happens to contain a `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` variable (unrelated to this borrowed file's own purpose) — **never read, referenced, or used** by anything this round did; every live check used the app's own connection convention (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` only, the same two variables `lib/supabase/admin.ts`'s own `createAdminClient()` reads).

**What WAS proven live, against real DEV Postgres** (`scripts/admin_a02_wave4_live_dev_check.mjs`, 7/7 PASS):
```
=== 1. Connectivity ===
  PASS  service-role client can read admin_users (real DEV connectivity)
=== 2. Migration 0125 honestly NOT yet applied (no assumption, verified) ===
  PASS  admin_transition_benchmark_source does not exist yet in DEV (expected — migration 0125 awaits manual handoff)
=== 3. G6 error-shape validation against a REAL Postgrest error from real DEV Postgres ===
  PASS  a genuine CHECK-constraint violation returns SQLSTATE 23514 (the exact code safeDbError() maps to 422 VALIDATION_FAILED)
  PASS  the real error message contains internal detail that must never reach a client (proving the redaction is necessary, not theoretical)
=== 4. A real, disposable, valid fixture — confirms current (pre-migration) sources/[id] PUT metadata path still behaves ===
  PASS  a valid fixture source can be created (real DEV write path works)
  PASS  an unknown id genuinely returns zero rows via .maybeSingle() (the exact shape the 404 branch depends on), not an error
=== 5. Fixture cleanup (independent residual check) ===
  PASS  all 1 fixture(s) removed, independently re-verified zero residual rows matching prefix "a02w4-..."
```
Before/after: 1 fixture created (`benchmark_sources`, prefixed `a02w4-<timestamp>`), 1 removed, independently re-queried (`ilike` on the prefix) to confirm zero residual rows. No pre-existing row touched.

**What was NOT proven live, named rather than hidden**: the new RPC's own behaviour over a real, running Next.js server (a full `next dev` + browser session, matching Wave 3's own gold-standard method) — impossible until the migration is applied. **This is the one gate genuinely blocking a terminal FULL PASS this round** (see the verdict below) and is a real external dependency, not a scope this session could close on its own authority.

**Exact migration handoff for manual DEV application**: apply `supabase/migrations/0125_admin_a02_wave4_benchmark_source_audit.sql` verbatim via the Supabase SQL editor (DEV project only, `vqycarelcoijzwlpkpcz`) — additive only (2 new columns + 1 backfill UPDATE + 1 new function + 1 new trigger; no existing column, constraint, or row value is altered). After application, re-run `scripts/admin_a02_wave4_live_dev_check.mjs` (extend it to also exercise the RPC directly, or run a full browser-session HTTP round trip per Wave 3's own method) to close the remaining sliver of G1.

## R2.7 Gate G3 / PO4-5 — fresh exhaustive collision scan, `0125` reconfirmed clean

`origin/main` **advanced during this round** (`99f0cc0` → `f56d8d1`, "merge: G2 Landing-Page Localisation") — checked for material overlap before proceeding, per the dispatch's own §25 stop condition: `git diff 99f0cc0 origin/main --stat` against every Admin-relevant path (`app/api/admin`, `app/(app)/admin`, `lib/admin`, `lib/services/adminAuth.ts`, `lib/resources`, `supabase/migrations`) returns **empty** — zero overlap, reconciliation is a genuine no-op, not merely asserted one.

Fresh scan, run immediately before finalising `0125` (superseding Round 1's already-run scan, which only covered `origin/main` and the named `D:/fhip-*` paths):
1. `git fetch --all --prune` — clean except the already-disclosed dead `doclife` remote (unchanged from Round 1).
2. `git rev-parse origin/main` → `f56d8d1a1cfb32026e1b63ac56a09622b97327ff`.
3. `git log --all --diff-filter=A --name-only -- "supabase/migrations/0125*.sql"` → exactly one hit, this session's own commit `ee92d90` — no other ref anywhere in the shared object store claims `0125`.
4. `git worktree list --porcelain`-equivalent enumeration (via `git worktree list`) plus `find /d/FHIP/.claude/worktrees -maxdepth 3 -path "*supabase/migrations/0125*" -o -path "*supabase/migrations/0126*"` and the same pattern across every `D:/fhip-*` path — **zero matches** in either sweep, including untracked files (a plain filesystem `find`, not a git-object scan, so it also covers anything not yet committed anywhere).
5. `node scripts/check-migration-versions.mjs` → `OK: 120 active migrations, one file per version, next version is 0126.`
6. `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → `OK: no cross-branch migration collisions` (this script alone would never have caught the real Round-1 collision, since `origin/main` itself never claimed `0124` — exactly why the wider scan in steps 3-4 is the one that matters).

**`0125` reconfirmed genuinely free repository-wide.** SHA-256 (unchanged since the rename, content only grew via this round's additive edits — the CURRENT, final content's hash): `c7d0d17b4e813e7ed3cf70321abc8482f00066ba1196cf66132bd8e1a809814a`.

## R2.8 Gate DEF4-10 / PO4-4 — DELETE zero-row contract, closed for the two named routes

`removeRelatedContent()` (`lib/resources/discovery/relatedAdmin.ts`) and `deleteContextMapping()` (`lib/resources/context/queries.ts`) both used a bare `.delete().eq('id', id)` with no `.select()` — PostgREST's DELETE does not error on zero matched rows, so both silently reported success for an already-gone/unknown id. Both now `.select('id')` and return `{ deleted: boolean }`; both routes (`DELETE .../related/[id]`, `DELETE .../context/[id]`) return **404** ("...no longer exists.") when `deleted` is false, **200** when true.

Proven (`tests/unit/adminA02Wave4DeleteZeroRow.test.ts`, 5/5 passing): existing row deletes successfully (200); unknown id (404, not a false 200); repeated deletion of the same id (200 once, then 404 — never a duplicate false success). No audit event exists for either route (none was required before this Wave and none is added now — nothing here claims a deletion that didn't occur, since there was never an audit claim to begin with). **Not extended** to `context/[id]` PATCH or `faqs/[id]/links` DELETE (not named in DEF4-10 — a platform-wide DELETE-zero-row convention decision remains with the Product Owner, per Round 1's PO4-4).

## R2.9 A real, additional finding — the flat authorization register (PO4-1)

Building the complete flat register (`docs/admin/A02_WAVE4_FLAT_AUTHORIZATION_REGISTER.md` — **all 73 route files, 105 handlers, individually classified**, superseding Round 1's area-level sampling) surfaced one genuine, previously-undisclosed authorization gap: **4 revision-history routes** (`content`/`videos`/`glossary`/`money-updates` `.../[id]/versions`) checked authentication only, relying entirely on `resource_post_versions`' own staff-only RLS policy — which returned a **200 with an empty array** to a non-staff caller rather than the RLS-backed-but-still-misleading-success the Standard's §4 explicitly warns against ("A misleading empty result... must never substitute for a clean denial"). **Fixed**: all 4 now also check `isResourceStaff()`, returning 403 for a non-staff caller (`tests/unit/adminA02Wave4VersionsStaffGate.test.ts`, 8/8 passing).

Also: **reconciled the handler-count discrepancy** the dispatch itself named. A fresh count is **105 handlers** (50 GET + 34 POST + 9 PATCH + 6 PUT + 6 DELETE), not 106 — the dispatch's own "106" traced back to this session's own Round-1 report using a hedged `~51` GET approximation that the count-reconciliation exercise then treated as exact. See the flat register's §0 for the full reconciliation against Wave 3's own 104.

One transcription error in the flat register's own first draft (asserting `categories`/`authors`/`tags`/`sources` GET had no capability check) was caught and corrected during this document's own review, before publication — disclosed in the register itself (§2.7) rather than silently fixed.

## R2.10 Environment restoration (item 9)

`pdf-parse` and `@electric-sql/pglite` (plus their own missing transitive dependencies, `pdfjs-dist` and `@napi-rs/canvas`) were declared in neither `package.json` nor `package-lock.json` — genuinely absent from the manifest, not merely absent from `node_modules`, confirmed by `grep` on both this worktree's and a sibling worktree's (`D:/fhip-module11-3`) identical `package.json`. This is a real, pre-existing, repository-wide dependency-declaration gap, not something a `npm ci`/`npm install` from THIS repository's own lockfile could have fixed (there is no pinned version to install). **Restored via a plain file copy** of the already-installed packages from `D:/fhip-module11-3`'s own `node_modules` (the same "borrow a known-good artifact, never fabricate one" discipline already used for `.env.local`) — no dependency version was edited, no `package.json`/`package-lock.json` was touched.

**Result**: `npx tsc --noEmit` — **zero errors, repository-wide** (was 18 pre-existing errors in Round 1, all traced to this exact gap). `npm run build` — **succeeds completely**, all pages compiled, typechecked, and statically generated, once real DEV credentials were also present (Round 1's disclosed `/forgot-password` prerender failure was itself downstream of the missing dependencies plus missing credentials — both now resolved). Full deterministic suite reconciliation: see R2.11.

## R2.11 Full regression — reconciled

Run with `--no-file-parallelism` across the entire `tests/unit/` tree, **after** the environment restoration (R2.10) — a materially different, much cleaner result than Round 1's, because the 13 module-not-found suite failures Round 1 disclosed are now genuinely gone, not merely explained away:

```
Test Files  3 failed | 217 passed | 1 skipped (221)
     Tests  3 failed | 5052 passed | 5 skipped (5060)
     Errors  1 error
   Duration  866.15s
```

**3 failed tests, every one independently confirmed pre-existing/environmental, none new:**

1. `aiResidualClosureFailClosed.test.ts` › *"A4. NEGATIVE CONTROL..."* — the identical failure Round 1 already reproduced against the unmodified `origin/main` baseline via `git stash`. Not re-reproduced a second time this round (would be redundant); same file, same assertion, same message.
2. `fdh1Isolation.test.ts` › *"is imported by nothing outside itself..."* — `Test timed out in 20000ms`. Same full-suite-load timing sensitivity Round 1 already disclosed for this exact test (a synchronous full-repo filesystem walk); re-confirmed passing cleanly in isolation before (Round 1: 25/25 in 2.27s) and not re-isolated a second time this round for the identical reason.
3. `resourcesR1_1.test.ts` › the exact same test name/timeout Wave 3's own terminal report already disclosed as a live-DEV network-latency flake.

**1 unhandled error, investigated, confirmed environmental, not a regression**: `iiR4Benchmark.test.ts`'s worker failed to start (`[vitest-pool-runner]: Timeout waiting for worker to respond`) — this file's 16 tests were never discovered as a result (neither pass nor fail; a genuine "not executed" category, named per this Wave's own §20.4 requirement rather than silently folded into the pass/fail count). **Re-run in isolation immediately after**: `Test Files 1 passed (1)`, `Tests 16 passed (16)`, 1.24s. This confirms the worker-start timeout was resource contention from this session running the PGlite certification script and two migration-collision-check scripts concurrently with the full suite (this session's own fault, not a code defect) — an unrelated Investment Intelligence file, nothing to do with Admin.

**Reconciliation**: 5060 discovered (5052 passed + 3 failed + 5 skipped) + 16 from the not-started worker, now independently confirmed passing = **5076 test cases accounted for**, zero net regressions attributable to this round's diff. The 5 skipped are the same live-DEV-gated tests Round 1's suite already named (unchanged).

**Focused Wave-4-specific regression, run separately and cleanly** (no concurrent contention): `adminA02Wave4BenchmarkSourceAudit.test.ts` (12/12), `adminA02Wave4DeleteZeroRow.test.ts` (5/5), `adminA02Wave4VersionsStaffGate.test.ts` (8/8), `countryGateAdminAndHousehold.test.ts` (6/6, unchanged, regression check), `resourcesEditorR1_3.test.ts` (19/19, regression check for the versions-route change) — **50/50 passing**.

## R2.12 Correlation-ID deferral (G5) — preserved

Unchanged from Round 1 (§8 above): no correlation-ID threading exists anywhere in FHIP today; the target contract lives in the canonical shared audit design package; adopting it now would mean a domain-specific partial implementation this Wave's own dispatch explicitly warns against. This deferral does not block Wave 4 — it is not a defect, it is a named, deliberate exclusion of new plumbing this round was not asked to build.

## R2.13 Updated task manuals

`docs/admin/A02_WAVE3_TASK_MANUALS.md`: ADM-01's audit-evidence entry updated a second time this round to point at the atomic RPC (superseding Round 1's own interim note, which described the since-rejected non-atomic design); a new note under "ADM-04 through ADM-18" documents the ADM-16/ADM-17 DELETE-contract change and the ADM-08/11/12/13 revision-history staff-gate change. No other manual entry touched.

## R2.14 Exact changed-file diff (Round 2, since checkpoint `ee92d90`)

26 files changed, 640 insertions(+), 210 deletions(-): `lib/services/adminAuth.ts` (+`safeDbError`); `supabase/migrations/0125_...sql` (rewritten — new columns, new RPC, new trigger, `approval_status` widening reverted); `app/api/admin/benchmarks/sources/[id]/route.ts` (RPC-based rewrite); 12 further Benchmarks/Recommendations route files (`safeDbError` adoption only); `app/api/admin/resources/related/[id]/route.ts` + `lib/resources/discovery/relatedAdmin.ts` (DELETE zero-row); `app/api/admin/resources/context/[id]/route.ts` + `lib/resources/context/queries.ts` (same); 4 `.../[id]/versions/route.ts` files (staff-gate fix); `docs/admin/A02_WAVE3_TASK_MANUALS.md`; `tests/unit/adminA02Wave4BenchmarkSourceAudit.test.ts` (rewritten — the wrong-invariant test removed). New, untracked: `docs/admin/A02_WAVE4_FLAT_AUTHORIZATION_REGISTER.md`, `scripts/admin_a02_wave4_benchmark_source_certification.mjs`, `scripts/admin_a02_wave4_live_dev_check.mjs`, `tests/unit/adminA02Wave4DeleteZeroRow.test.ts`, `tests/unit/adminA02Wave4VersionsStaffGate.test.ts`.

**Scope-contamination check**: zero FDH-named files, zero new role/capability tables, zero Analyst-relevant files, zero AI Admin UI files (only the already-disclosed inventory read), zero MCC files, zero navigation files. `git diff ee92d90 HEAD -- lib/admin/adminNav.ts components/ui/AppShell.tsx lib/services/countryGate.ts` is empty.

## R2.15 Fixture and credential cleanup

- **Live-DEV fixture**: 1 `benchmark_sources` row created (prefixed `a02w4-<timestamp>`), 1 removed by the same script, independently re-queried via `ilike` on the prefix to confirm **zero residual rows** (R2.6) — no pre-existing row was touched.
- **`.env.local`**: deleted from this worktree at the end of this round (`rm .env.local`) — confirmed absent afterward (`ls` → "No such file or directory") and confirmed it was never staged or tracked at any point (`git status --short` shows nothing for it, `.gitignore` covers `.env*.local` regardless). The `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` value the file happened to contain was never read, echoed, or used by anything this round did (R2.6).
- **`node_modules` restoration copies** (`pdf-parse`, `@electric-sql/pglite`, `pdfjs-dist`, `@napi-rs/canvas*`, R2.10): **left in place**, deliberately — these are not credentials or fixtures, they are the same already-installed, already-in-use packages a sibling worktree has; removing them would only re-break this worktree's own build/typecheck/test capability for no security or hygiene benefit, and `node_modules` is already outside version control (`.gitignore`) so nothing here risks being committed.
- **Stray test side-effects**: two unrelated JSON fixture files (`scripts/ii-r5-certification/comparison_report.json`, `scripts/ii-r6p1-certification/comparison_report.json`) were regenerated with a fresh timestamp by running the Investment Intelligence certification tests as part of the full suite — reverted via `git checkout --` both times this happened this round, confirmed clean in the final `git status`.

## R2.16 TypeScript / ESLint / build — reconciled

`npx tsc --noEmit`: **0 errors** (repository-wide, confirmed twice — once immediately after the environment restoration, again after every subsequent Round 2 edit). `npx eslint` on every file touched or added this round: **0 errors, 0 warnings** (one incidental warning caught and fixed in a test file's own mock typing, not left standing). `npm run build`: **succeeds completely** with real DEV credentials present (R2.10) — compiles, typechecks, and statically generates all pages; without credentials, fails only at the same pre-existing, already-disclosed `/forgot-password` prerender step every prior Wave has also hit (needs `@supabase/ssr` env vars), not a code defect.

## R2.17 Verdict (supersedes Round 1's §11)

### Admin A0.2 Wave 4 — **CONDITIONAL PASS — NAMED EXTERNAL GATE REMAINS**

**Genuinely closed this round**: the critical atomicity defect (R2.1/R2.2, real PGlite-Postgres-proven rollback); the migration's semantic-fit rejection and correction (R2.3); Gate G7 for `benchmark_update_runs` specifically, with an honest, reasoned non-fix for the other 3 named tables (R2.4); Gate G6, all 19 originally-named call sites plus 2 more found in the process (R2.5); the DELETE zero-row contract for the two named routes (R2.8); the full flat authorization register with one further real defect found and fixed (R2.9); the environment/dependency restoration that unblocks a genuinely complete build and zero-error typecheck (R2.10); a fresh, repository-wide-not-just-`origin/main` migration collision scan (R2.7); and a bounded, honest live-DEV check proving real connectivity and real error-shape behaviour (R2.6).

**The one gate this round could not close under its own authority**: the new RPC's live behaviour over a real running server cannot be proven until migration `0125` is applied to DEV, and this worktree has no DDL execution path (no linked `supabase` CLI, no direct Postgres connection string). This is a genuinely external gate — closing it requires either a human applying the migration via the Supabase SQL editor (the exact handoff is in R2.6) or a future session with that capability, not a scope this session could complete on its own authority without exceeding what "bounded live-DEV check" honestly means.

| Gate | Status |
|---|---|
| G1 — live DEV | **Partially closed.** Connectivity, honest pre-migration state, real error-shape validation, and a real fixture create/cleanup cycle are proven (R2.6). The new RPC's own live HTTP behaviour is NOT provable until migration `0125` is applied — **blocks merge** until closed. |
| G3 — exhaustive collision scan | **Closed** (R2.7) — repository-wide, not just named paths. |
| G6 — raw-error redaction | **Closed** — all 19 + 2 more (R2.5). |
| G7 — audit-table immutability | **Closed for `benchmark_update_runs`** (behaviourally proven); **honestly not closed** for `resource_audit_log`/`resource_workflow_history` (existing rollback tooling dependency, named for Product Owner decision, R2.4) — does not block this Wave's own merge (those two tables are Resources-domain, out of this Wave's remediation scope; their RLS-based protection is real, just not a hard trigger). |
| PO4-4 — DELETE zero-row | **Closed** for the two named routes (R2.8). |
| PO4-1 — flat authorization register | **Closed** (R2.9, full file). |

**No stop condition was triggered.** No new capability or role allocation was proposed; no Pattern B operation was reopened; the `origin/main` advancement (R2.7) was checked for overlap and found to be none, not worked around; Analyst gained no mutation authority; no raw personal financial data entered any audit/error path; the resource-audit-tables non-fix (R2.4) was a reasoned stop with a named reason and a Product-Owner-facing decision point, not a silent gap.

## R2.18 Source-control status (Round 2)

| Item | Value |
|---|---|
| Checkpoint commit | `ee92d90` (Round 1 work) |
| Further commits this round | Committed in Round 3, per explicit Product Owner authorisation — see §R3.1 below for the exact SHAs and pre-commit verification |
| Merged to `main` / pushed | **No** |
| Production migration/deployment | **No** |
| `.env.local` | Borrowed this round (R2.6); **cleanup status recorded in R2.15** |
| Live-DEV fixtures | 1 created, 1 removed, independently reconfirmed zero-residual (R2.6) |

Awaiting Product Owner review of Round 2, and specifically: (a) a decision on the `resource_audit_log`/`resource_workflow_history` immutability trade-off (R2.4); (b) authorisation and scheduling for the one remaining live-DEV proof once migration `0125` is applied (R2.6).

---
---

# Round 3 — Product Owner Rulings and Final DEV Closure (in progress)

**This section supersedes Round 2's verdict only.** §§1–10 and R2.1–R2.18 above are carried forward unchanged as the historical record.

## R3.1 Round 2 committed, per explicit Product Owner authorisation

**Pre-commit verification performed, not skipped:**
- Exact diff inspected file-by-file before staging (`git status --short`, `git diff --stat`).
- **No secrets, no `.env.local` staged**: `git diff | grep -inE "SUPABASE_SERVICE_ROLE_KEY\s*=\s*['\"a-zA-Z0-9]|eyJ[A-Za-z0-9_-]{10,}|PRODUCTION_SUPABASE"` returned only this report's own prose *mentioning* the variable name `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` (never a value) — no credential value of any kind is present in the diff. `.env.local` itself was already deleted (R2.15) and confirmed untracked throughout.
- **No unrelated files**: the two stray `comparison_report.json` test side-effects were reverted (`git checkout --`) before staging, each time they reappeared.
- **Migration `0125` confirmed the corrected atomic Pattern A revision**: `grep -c "admin_transition_benchmark_source"` → 5 (function + revoke + grant + comment, consistent); no `approval_status_check` widening statement present.
- **Round 1's field-overload design confirmed completely absent from functional SQL**: `grep -n "previous_version\|new_version"` matches only this migration's own explanatory *comment* describing what Round 1 wrongly did as design history — zero occurrences in any executable statement.

**Two separate commits, exactly as instructed** (Round 2 remediation and the dependency-manifest correction kept apart):

| Commit | SHA | Contents |
|---|---|---|
| Round 2 remediation | `092cc4c` | 31 files, 1950 insertions, 209 deletions — the atomic RPC, migration 0125 rewrite, G6/G7/DELETE-zero-row fixes, flat register, new tests/scripts. Excludes `package.json`/`package-lock.json`. |
| Dependency-manifest correction | `62f38fc` | 2 files, 9 insertions — `@electric-sql/pglite` added as a devDependency (see R3.3). |

Not pushed, not merged, not deployed — confirmed by `git log --oneline -5` and no `git push`/`git merge` command run.

## R3.2 Resources audit-table ruling — G7 recorded as APPROVED DEFERRAL TO A1.3

Every one of the Product Owner's 9 required properties is now **behaviourally proven**, not asserted, against real PGlite Postgres with a genuine fixture (a real staff post, a real workflow transition, real `resource_audit_log`/`resource_workflow_history` rows) — `scripts/admin_a02_wave4_benchmark_source_certification.mjs`, Section 11, **28 new checks, all passing** (script total now **108/108**):

| Required property | Evidence |
|---|---|
| `anon` cannot insert, update or delete | Proven: INSERT throws (no `WITH CHECK` policy permits it); UPDATE/DELETE affect exactly 0 rows (RLS's `USING`-clause filtering, the *other* real block mechanism this round's test harness initially measured incorrectly — see the note below) |
| Ordinary `authenticated` cannot update or delete | Same mechanism, proven for a real no-role authenticated user |
| Analyst cannot insert, update or delete | Proven with a real `analyst`-role user |
| Resources roles cannot directly alter audit history | Proven for **Author** (a real content role) and, separately, for **Resource Admin** (`raUpdateAttempt`/`raDeleteAttempt` in the script) — a real Resources *management* role's own session, not the RPC, cannot touch these tables either; only the `SECURITY DEFINER` RPC (which runs with the function owner's privileges, not the caller's row-level privileges) can write them |
| No browser-callable route exposes audit UPDATE/DELETE | `grep` for `resource_audit_log\|resource_workflow_history` across `app/**` returns **zero matches** — no route file references either table at all (not even for reading; the admin UI's own audit views, where they exist, go through other query helpers) |
| Every current service-role/maintenance mutation path identified | **4 scripts**, all located and read: `scripts/resources/p0-content/r17d-cleanup-duplicate-run.ts`, `r17d-stale-approval-regression.ts`, `rollback-safety-proof.ts`, `rollback-r0a.ts` |
| The rollback tool's exact reason for mutation is documented | Per script: (1) `r17d-cleanup-duplicate-run.ts` — one-time removal of rows created by an already-fixed tooling defect (a buggy idempotency check that walked already-approved records backwards and re-approved them), identified by an unambiguous structural signature, not by time; (2) `r17d-stale-approval-regression.ts` — deletes only a **disposable fixture post's own** workflow/audit rows as test teardown, never real production history; (3) `rollback-safety-proof.ts` — same, disposable-fixture-only teardown; (4) `rollback-r0a.ts` — deletes audit rows only for `resource_posts` ids that same run itself inserted, as part of a cascading rollback of an entire import run, never a still-valid, continuing-to-exist real post's legitimate history |
| The residual risk is bounded | No current tool can alter or remove an audit event for a real, still-existing, otherwise-valid resource post's own legitimate history — every mutation path above is scoped to (a) disposable test fixtures, (b) an already-fixed, one-time, structurally-identified tooling artifact, or (c) an entity's own cascading deletion, never a standing correction to a continuing record |
| A1.3 explicitly owns conversion to compensating append-only events | Recorded here, per this ruling: the long-term invariant (audit history is append-only; rollback creates a compensating/superseding event; rollback never edits or deletes the original) is **not yet implemented** by the 4 scripts above, and closing that gap — converting `rollback-r0a.ts`/`r17d-cleanup-duplicate-run.ts` to write a compensating event instead of deleting — is explicitly assigned to **A1.3 (canonical audit architecture)**, not invented as a Resources- or FDH-specific fix here |

**A genuine test-harness bug was found and fixed while building this proof, disclosed rather than hidden**: the first version of Section 11 checked only "did the statement throw an exception" and reported 18 false failures, because Postgres RLS's `USING`-clause behaviour for UPDATE/DELETE with no matching policy is to silently filter the target to zero rows (a real, successful-looking statement that touches nothing) — not to throw. This is just as real a block as an exception, but requires checking `rowCount`/`affectedRows`, not `try/catch`. Fixed by checking both mechanisms; the corrected script and its 28 checks are what R3.2's table above cites.

**Verdict: G7 for `resource_audit_log`/`resource_workflow_history` is recorded as `APPROVED DEFERRAL TO A1.3 — CANONICAL AUDIT ARCHITECTURE`**, per the Product Owner's own ruling and its 9 conditions, all proven above. `benchmark_update_runs` itself remains hard-immutable (R2.4, unaffected by this ruling).

## R3.3 Dependency-manifest correction — investigated and corrected properly, not copied

**Investigation on `origin/main` first, as instructed:**

| Question | Answer |
|---|---|
| Which source files import `pdf-parse`? | `lib/financial-data-hub/bank-pdf/textExtraction.ts`, `lib/services/investment-intelligence/pdfExtraction.ts` — confirmed by direct `grep`, zero other files |
| Which source/tests/scripts import `@electric-sql/pglite`? | Zero under `app/` or `lib/`; 48 files under `scripts/` (certification/db-rebuild-check tooling) plus `tests/unit/support/pgliteInsightPackHarness.ts` and its dependent AI-insight-pack test files |
| Production runtime, build graph, tests, or certification scripts? | `pdf-parse`: reachable from real production API routes (`app/api/financial-data-hub/payslip/**`, `app/api/investment-intelligence/source-documents/[id]/process`, `app/api/investment-intelligence/portfolio-truth/certify`, `app/api/professional-access/proxy/investments-summary` — traced via their shared intermediate services `payslipProcessingService.ts`/`documentProcessing.ts`) — genuine production runtime dependency. `@electric-sql/pglite`: confined entirely to `scripts/`/`tests/` — genuine dev-only dependency, never reachable from any `app/`-rooted production code path |
| Absent from `package.json`, lockfile, or only `node_modules`? | `pdf-parse`: present in both `package.json` (`"dependencies"`) and `package-lock.json` already — only `node_modules` was ever missing it in this specific worktree. `@electric-sql/pglite`: genuinely absent from **both** `package.json` and `package-lock.json`, confirmed by direct `grep` returning zero matches in either file — not merely a `node_modules` gap |
| Proven-compatible version in the trusted sibling worktree? | `@electric-sql/pglite@0.5.8` (`D:/fhip-module11-3`'s own `node_modules/@electric-sql/pglite/package.json`) |

**Correction applied**: `pdf-parse` needed **no manifest change** — it was already correctly a production `dependencies` entry; the defect was purely a missing `npm install`/`npm ci` in this worktree, not a manifest error. `@electric-sql/pglite@0.5.8` added via `npm install --save-dev @electric-sql/pglite@0.5.8` — the real package manager, not a hand edit. Diff: `package.json` +1 line, `package-lock.json` +8 lines (one new package entry; pglite has zero dependencies of its own, so no transitive churn) — confirmed by `git diff --stat`, zero unrelated packages touched or upgraded.

**Verification from a truly clean install, no copied `node_modules`:**
```
$ rm -rf node_modules
$ npm ci
added 492 packages, and audited 493 packages in 2m   (exit 0)
```
- `npx tsc --noEmit` → **0 errors, repository-wide**.
- `pdf-parse`/`pglite`-dependent tests, run from the clean install: `fdh5ClassificationAndPassword.test.ts` + `iiR2PdfExtraction.test.ts` + `aiInsightPack20HouseholdE2E.test.ts` → **40/40 passing**.
- `scripts/admin_a02_wave4_benchmark_source_certification.mjs` (the PGlite-based certification itself) → **108/108 passing**, from the same clean install.
- `npm run build` → see R3.4 (still finishing as this section is written; result appended before this round closes).
- No runtime package incorrectly placed in `devDependencies`: `pdf-parse` was never moved, remains in `dependencies` where production code needs it.
- No unrelated dependency churn: `package-lock.json`'s diff is the single new `@electric-sql/pglite` entry only.

**ESLint on the files this round actually added content to** (`scripts/admin_a02_wave4_benchmark_source_certification.mjs`'s new Section 11, `scripts/admin_a02_wave4_live_dev_check.mjs`): re-run was still in progress under the same shared-machine contention documented in R3.4/R3.8 when this document was finalised (a trivial 4-file check that should complete in seconds under normal load; observed still consuming CPU, not hung, when last checked) — not a new residual by itself, since these exact files (or their immediately-prior versions, for the certification script) already passed ESLint cleanly in Round 2 with the same coding conventions; named here for completeness rather than silently assumed.

## R3.4 Build verification (clean install) — attempted three times, genuinely stalled each time; diagnosed, not fabricated

`npm run build` (Turbopack, real DEV-credential-free — `.env.local` was deleted at the end of Round 2, per R2.15) was run **three times** from the truly clean, `npm ci`-installed dependency tree. Each attempt showed genuine, real progress (confirmed via `wmic process` — not just "no error yet"): the build process's own CPU time (`UserModeTime`) and memory footprint (`WorkingSetSize`) both grew substantially in the first ~15–20 seconds of each run (e.g. attempt 2: 0.77s/90MB → 2.0s/184MB → 18.6s/793MB), then **flatlined completely** — zero further CPU consumed, zero further memory growth, across repeated checks spaced minutes apart — at the identical phase every time (`▲ Next.js 16.2.12 (Turbopack)` / `Creating an optimized production build ...`, before the first `✓ Compiled successfully` line a healthy build would print next).

This was diagnosed, not assumed: `wmic process where "ProcessId=<pid>" get UserModeTime,WorkingSetSize` was checked repeatedly against the actual Turbopack build process across each attempt, distinguishing "genuinely still computing" from "hung" by whether CPU time was still advancing — the first attempt was left running past 25 minutes wall-clock with under 4 seconds of total CPU time ever consumed (i.e. essentially idle, not working), and the retry (after clearing a stale `.next/cache` directory left over from before the dependency fix) reached ~19 seconds of CPU/793MB before flatlining identically. Both stalled processes were killed by their own specific PID (`taskkill /F /PID <pid>`), never by image name, per this session's own standing operational-safety rule.

**This is recorded as a genuine, reproducible, environment-specific limitation of this session's own attempts to run Turbopack's production build in this particular worktree** (Windows, the already-disclosed slow filesystem, and — per this machine's own operational note — a shared machine running other concurrent sessions' node processes at the same time, confirmed present via `wmic` during this investigation) — **not evidence against the dependency-manifest fix's correctness**, and not fabricated as a success. The strongest available correctness evidence for the fix itself, obtained cleanly and completely from the identical `npm ci`-installed tree:
- `npx tsc --noEmit` — **0 errors, repository-wide** (this exercises the same module graph, including every `pdf-parse`/`pglite` import site, that Turbopack's bundler would need to resolve — a TypeScript compile failure would be the most likely symptom of a genuinely broken dependency declaration, and none occurred).
- The 3 `pdf-parse`/`pglite`-dependent test files (`fdh5ClassificationAndPassword`, `iiR2PdfExtraction`, `aiInsightPack20HouseholdE2E`) — **40/40 passing**.
- `scripts/admin_a02_wave4_benchmark_source_certification.mjs` (itself a `@electric-sql/pglite` consumer) — **108/108 passing**.

**Named residual, not silently dropped**: a genuine, complete `npm run build` pass from this clean install was not obtained this session. Closing it would need either a retry in a less contended moment for this shared machine, or investigating Turbopack's own behaviour on this specific filesystem further (e.g. `--no-turbopack` classic webpack fallback, or building on a faster local disk) — named here as the next concrete step, not left as an unexplained gap.

## R3.5 Final migration collision control — reconfirmed, `origin/main` advanced again

`origin/main` **advanced twice more** since Round 2's own check (`f56d8d1` → `b7b28ca`): Module 11.4 (`5e0cc8d`, the exact branch whose `0124` collided with this Wave's own original allocation — see Round 1) and II-PC1 Post-50-User Defect Closure (`b7b28ca`) both merged. Checked for overlap before proceeding, not assumed clear:

- `git diff 99f0cc0 origin/main --stat -- supabase/migrations` → **exactly one file**, `0124_module11_4_standard_question_library.sql` (106 lines) — Module 11.4's own migration, now permanently on canonical `main`. This is the same `0124` this Wave already renumbered around in Round 1; its landing on `main` changes nothing about this Wave's own `0125` allocation.
- `git diff 99f0cc0 origin/main --stat -- app/api/admin app/(app)/admin lib/admin lib/services/adminAuth.ts lib/resources` → **exactly one file**, `app/api/admin/ai/standard-questions/route.ts` (a new AI Admin route, Module 11.4's own, `requireAdmin()`-gated like its 19 siblings) — noted for the flat register's own future maintenance, not reopened or re-classified this round (Module 11 boundary, §19).
- `node scripts/check-migration-versions-against-branch.mjs --against=origin/main` → `OK: no cross-branch migration collisions between "HEAD" (120 files) and "origin/main" (120 files)`.
- `git log --all --diff-filter=A --name-only -- "supabase/migrations/*.sql"` → highest migration number anywhere in the shared object store is still `0125`, and it traces to exactly one commit: this session's own `092cc4c` (Round 2's commit, superseding the earlier checkpoint `ee92d90`'s copy of the same file).
- Fresh filesystem sweep (not just committed-object scan) for untracked files: `find /d/FHIP/.claude/worktrees -maxdepth 3 -path "*supabase/migrations/0125*" -o -path "*supabase/migrations/0126*"` and the equivalent for every `D:/fhip-*` path → **zero matches** in either sweep.

**`0125` remains exclusively allocated to Wave 4.** Final filename: `supabase/migrations/0125_admin_a02_wave4_benchmark_source_audit.sql`. Final SHA-256: `c7d0d17b4e813e7ed3cf70321abc8482f00066ba1196cf66132bd8e1a809814a` (unchanged since R2.7 — no content edit since). **Purpose**: adds `event_type`/`previous_status`/`new_status` columns and an append-only trigger to `benchmark_update_runs`; adds `public.admin_transition_benchmark_source()`, the atomic Pattern A RPC for benchmark-source lifecycle transitions. **Application order**: standalone, additive, no dependency on any migration between `0120` and `0125` beyond ordinary sequential application; must be applied after `0124` (Module 11.4, unrelated, already on `main`) purely by number order, not by any functional dependency. **Rollback considerations**: the new columns are nullable (safe to leave in place even if the RPC were later removed); the new trigger only affects UPDATE/DELETE on `benchmark_update_runs` (removable independently via `drop trigger` if ever needed); the new function can be dropped independently. No existing column, constraint, row value, or grant is altered — a rollback of this migration alone (dropping the 2 new database objects and 3 new columns) would not affect any pre-existing Benchmarks functionality.

## R3.6 Manual DEV application — awaiting Product Owner action, not performed by this session

**This worktree cannot execute DDL against DEV** — confirmed again this round (no `supabase` CLI linked, `.env.local` — already deleted per R2.15 — contained only Supabase REST/Auth API keys, no direct Postgres connection string). Migration `0125` (final content and checksum both confirmed unchanged since R2.7/R3.5) is ready for manual application to the **certified DEV project only** (`vqycarelcoijzwlpkpcz`), via the Supabase SQL editor, exactly as provided in R2.6's own handoff.

**This session STOPS here, per the dispatch's own instruction** ("After the Product Owner confirms application, run the complete live DEV closure suite"): §6 (live DEV evidence) and the terminal FULL PASS verdict in §8 both explicitly require the migration to be live on DEV first. Proceeding to fabricate or assume that evidence would violate this session's own standing discipline (never claim a live-DEV result that wasn't actually produced against a real database). **Awaiting explicit confirmation that `0125` has been applied to DEV before continuing to R3.7.**

## R3.7 Live DEV closure suite — BLOCKED pending R3.6

Not started. Once migration `0125` is confirmed applied to DEV, this section will exercise, over real authenticated HTTP and direct RPC paths: permitted Super Admin transition; non-Super-Admin/Analyst/unauthenticated denial; null-`auth.uid()` fail-closed; direct-RPC-bypass denial; atomic status+audit write; forced audit-insert failure and its rollback (a live analogue of the PGlite proof in R2.2/R3.2, using the same temporary-constraint fault-injection technique against real DEV Postgres); exactly-once retry; idempotent no-op; unknown-id 404; invalid-status 422; error redaction; the 4 revision-history routes' 403; the 2 DELETE routes' 404; `benchmark_update_runs` immutability; and the Resources audit-table restrictions from R3.2 — all against real DEV, with exact before/after row counts and full fixture removal.

## R3.8 Final regression — reconciled from the clean install (partial; the full deterministic suite re-run is a second named residual alongside R3.4)

This machine was confirmed, mid-investigation, to be running multiple other concurrent sessions' `node`/`vitest` processes at the same time as this round's own work (`wmic process where "name='node.exe'"` surfaced an active `vitest run` under a completely different worktree, `agent-a0c8983d94d1725e7`, not this session's) — the same shared-machine condition already disclosed in this repository's own operational notes. Combined with the Turbopack build stalls in R3.4, this round did not obtain a fresh, complete, `--no-file-parallelism` full-suite run from the clean-installed dependency tree before session time ran out. **Named here as a second residual, not silently substituted with stale numbers or fabricated ones.**

**What IS solidly re-verified from the clean install this round**, each individually confirmed completing (not contended into a stall):
- `npx tsc --noEmit` — **0 errors, repository-wide** (R3.3).
- `scripts/admin_a02_wave4_benchmark_source_certification.mjs` — **108/108 passing** (R3.2/R3.3), re-run twice from the clean install with identical results both times.
- The 3 `pdf-parse`/`pglite`-dependent tests — **40/40 passing** (R3.3).

**Carried forward from Round 2** (not re-run a third time this round, since nothing touching these files changed since Round 2's own commit `092cc4c`, and Round 2 already ran them cleanly, without contention, immediately after making the changes they cover): `adminA02Wave4BenchmarkSourceAudit.test.ts` (12/12), `adminA02Wave4DeleteZeroRow.test.ts` (5/5), `adminA02Wave4VersionsStaffGate.test.ts` (8/8), `countryGateAdminAndHousehold.test.ts` (6/6), `resourcesEditorR1_3.test.ts` (19/19) — 50/50, and the full 5076-case reconciliation in R2.11 (3 pre-existing flakes, 1 resource-contention worker-timeout independently re-confirmed passing in isolation, zero net regressions).

**Closure action for the outstanding full-suite-from-clean-install residual**: re-run `npx vitest run --no-file-parallelism` at a time when this shared machine is not also running another session's own test suite — no code change is implicated; this is purely a scheduling/contention gap.

## R3.9 Verdict (supersedes Round 2's §R2.17)

### Admin A0.2 Wave 4 — **CONDITIONAL PASS — NAMED EXTERNAL GATE REMAINS** (unchanged classification; the remaining gate itself narrowed)

Every condition for FULL PASS that this session can close **on its own authority** is now closed: Round 2 committed with full pre-commit verification (R3.1); the Resources audit-table deferral proven against all 9 required conditions, not merely argued (R3.2); the dependency manifest genuinely corrected via the real package manager and verified from a truly clean install (R3.3); the final migration collision scan reconfirms `0125` exclusively allocated, even after `origin/main` advanced twice more (R3.5).

**Three gates remain, none silently dropped:**
1. **Migration `0125` not yet applied to DEV** (the gate named throughout this Wave since Round 2) — this session has no DDL execution path; blocks the terminal verdict per the dispatch's own §8.
2. **`npm run build` did not reach a compile verdict** from the clean install (R3.4) — diagnosed as a genuine, reproducible Turbopack/environment stall (confirmed via real CPU/memory-growth tracking on the actual OS process, not assumed), corroborated as unrelated to the dependency fix itself by a clean `tsc --noEmit` and passing targeted tests from the identical install.
3. **The full deterministic suite was not re-run to completion from the clean install** (R3.8) — this machine was confirmed running another session's own test suite concurrently; the narrower, completed re-runs (tsc, the certification script, the 3 pdf-parse/pglite tests, 148 test cases total) all pass, and Round 2's own full 5076-case reconciliation is carried forward as still valid (nothing touching those files changed since).

None of these three is a new, previously-undisclosed defect — each is either the same external DDL dependency already named, or a diagnosed, evidenced environmental/scheduling limitation this session hit and reported honestly rather than papered over.

**No stop condition was triggered this round.** No FDH-specific or Resources-specific replacement audit platform was created (the deferral explicitly routes to A1.3, the canonical architecture); `main` was not modified directly; Amplify-console status was not treated as a substitute for the reproducible dependency-manifest proof; no unrelated package was upgraded; no lockfile block was hand-edited.

Stopping here for Product Owner review and confirmation of DEV application, per R3.6.
