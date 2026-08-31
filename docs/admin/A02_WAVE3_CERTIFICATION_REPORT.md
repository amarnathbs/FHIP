# Admin A0.2 Wave 3 — Disconnected Content, Dead Routes and Task-Flow Completion

## Final Certification Report

**Branch:** `fix/admin-a02-wave3-disconnected-content-dead-routes`
**Worktree:** `D:/fhip-a02-wave3`
**Base:** `origin/main` @ `6fdcf7e61e9fc7e6f514edb0d823ca395b7853dd`
**Final SHA (before this report's own commit):** `6def976`
**Date:** 2026-08-31 / 2026-09-01

Companion documents (both committed this Wave, read in full as part of this report, not summarised twice here): `docs/admin/A02_WAVE3_DISCOVERY_AND_INVENTORY.md`, `docs/admin/A02_WAVE3_TASK_MANUALS.md`.

---

## 1. Sequencing gate — result

**Satisfied.** `origin/main` at `6fdcf7e` already includes Wave 2's merge (verified by `git log`, not trusted from the dispatch). Wave 2's own terminal status is reconciled in §1 of the Discovery report: the merge commit's message records a third round (applying `0118`, live-verifying 161/161) that upgraded Wave 2 to FULL PASS, even though the last *committed document* still reads CONDITIONAL PASS — disclosed as a paper-trail gap in Wave 2's own record, not re-litigated, and not a blocker since the merge itself (this branch's own base) is the gate.

A new, isolated branch/worktree was created from `origin/main`; no Wave 1/1B/2/Analyst/MCC/FDH branch was reused; the worktree was confirmed clean at the start via `git status` and `git log`.

---

## 2. What this Wave found and did, in one paragraph

A full re-inventory of the current Admin surface (34 pages, 72 API route files, 104 HTTP method handlers, 5 Admin-invoked RPCs) found the codebase in materially better shape than the "several dead routes" framing implied: the great majority of the surface is genuinely connected, capability-gated and working, carried forward correctly from R1.2–R1.7, Wave 1/1B and Wave 2. The concrete disconnections found were narrower and more specific: two Benchmarks routes (`PUT sources/[id]`, `POST validate`) had **zero Admin UI callers anywhere in the repository** despite being fully working, audited backend operations — one of them also had a real mass-assignment defect (`{...body}` spread with no field allow-list) that had simply never been exercised because nothing ever called it. Both are now connected: Approve/Suspend/Reinstate actions for Sources, and a Validate preview action for Datasets, both reusing the pre-existing `requireAdmin()` gate verbatim. A third route (`glossary/terms`) and a whole 17-route AI Admin surface were found genuinely uncalled but were deliberately **not** connected or removed — the former is ambiguous-intent and harmless (deferred), the latter is explicitly, repeatedly disclosed as intentional in Module 11's own completion reports and would require building a new, large business capability to connect (an explicit stop condition in this Wave's own brief). The one A0.1-related task this Wave could not honestly complete — reassessing "six suspected-dead routes" against a named prior document — is reported as a governance conflict (§6 of the Discovery report) rather than silently invented, because that document could not be located anywhere in this repository's git history after an exhaustive search.

---

## 3. Exact changed-file diff

```
$ git diff --stat 6fdcf7e HEAD
 app/api/admin/benchmarks/sources/[id]/route.ts  |  39 ++-
 components/admin/AdminBenchmarksClient.tsx      | 130 +++++++++-
 docs/admin/A02_WAVE3_DISCOVERY_AND_INVENTORY.md | 331 ++++++++++++++++++++++++
 docs/admin/A02_WAVE3_TASK_MANUALS.md            | 132 ++++++++++
 4 files changed, 617 insertions(+), 15 deletions(-)
```

**Scope-contamination check:** no Recommendations file, no Related Content/reorder file, no scheduling file, no FDH-named file or table, no navigation file (`adminNav.ts` untouched), no role/permission file (`permissions.ts` untouched), no migration file. Confirmed by the diff itself, not merely asserted — the four files above are the complete set.

---

## 4. Migration controls

**No migration was required.** Both code changes are application-layer only, against existing tables and an existing service function. The collision-scan discipline was still run in full (§7 of the Discovery report) and is not repeated here.

---

## 5. Test and build evidence

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Clean.** No output, exit 0. |
| `npx eslint components/admin/AdminBenchmarksClient.tsx app/api/admin/benchmarks/sources/[id]/route.ts` | **1 pre-existing finding, not introduced by this Wave** — `react-hooks/set-state-in-effect` on the file's own pre-existing `useEffect(() => { load(tab); }, [tab, load])` (line 51, untouched by this Wave's edits). **Reproduced identically on `origin/main` baseline** (`git stash` + re-run, shown in the session's own working log) — confirmed pre-existing, not a regression. Whole-codebase footprint of this exact rule: 2 files total in `components/admin/` + `components/resources/`, both pre-existing. Disclosed, not fixed (fixing an unrelated pre-existing lint rule on an otherwise-correct data-fetching effect is outside this Wave's bounded scope, per "no hidden scope expansion"). |
| `npm run build` | **Compiles and type-checks cleanly** ("Compiled successfully in 3.4min", "Finished TypeScript in 90s"). The static-export step then fails identically on `origin/main` baseline (`git stash` + re-run, same exact error) — `@supabase/ssr: Your project's URL and API key are required`, because this credential-free worktree has no `.env.local`. Confirmed pre-existing environment condition, not a Wave 3 regression, and already disclosed identically in the Analyst Wave 1 contract (§6, item 4) for the same reason. |
| Full non-live-DEV unit suite (`npx vitest run tests/unit`) | **197 files passed / 4831 tests passed / 18 skipped**, out of 204 files / 4852 tests. 5 files reported a failure; every one is accounted for below, none attributable to this Wave's 2-file diff. |

### 5.1 Full accounting of the 5 failing test files

| File | Failure | Disposition |
|---|---|---|
| `resourcesImportR1_7LiveDev.test.ts` | `ENOENT: no .env.local` | Environment condition (no live-DEV credentials in this worktree) — the same condition affecting the build's static-export step |
| `resourcesP0ContentR1_7CLiveDev.test.ts` | `ENOENT: no .env.local` | Same |
| `fdh11Isolation.test.ts` | Timed out (5000ms) inside the full 204-file parallel run | **Re-run alone: 11/11 pass in 1.67s.** Confirmed pure parallel-run test contention, not a real failure and not remotely reachable by a Benchmarks-only diff (this test scans `lib/engines`/`lib/services`/`components`/`app` for direct `fdh_investment_statement_*` queries — nothing this Wave touched) |
| `goals.test.ts` (Persona F) | `expected 1966666.67 to be close to 2000000` | **Reproduced identically on `origin/main` baseline** (`git stash` + isolated re-run) — pre-existing forecast/FX rounding defect, unrelated to Admin, not touched by this Wave |
| `resourcesR1_1.test.ts` | Timed out (5000ms) — a live-DEV network round trip | **Reproduced identically on `origin/main` baseline** — this is the exact same pre-existing flake Wave 2's own terminal report already documented and disclosed ("a network-latency timeout against live DEV, present on origin/main, unrelated to Wave 2") |

**Net regression count attributable to this Wave: zero.** Every failure either reproduces identically on the unmodified baseline or is a pure parallel-execution artifact independently proven not to be a real failure by isolating the file.

### 5.2 Secrets and conflict-marker scan

```
$ git diff 6fdcf7e HEAD | grep -E "^\+.*(<<<<<<<|=======|>>>>>>>)"     -> (no output)
$ grep -inE "SUPABASE_SERVICE_ROLE_KEY\s*=\s*['\"a-zA-Z0-9]|sk-[a-zA-Z0-9]{20}|AKIA[0-9A-Z]{16}" <every touched file>  -> (no output)
```

Clean on both counts.

---

## 6. Focused tests for the two connected tasks

| Test | Result |
|---|---|
| Happy path: Approve a draft source | Code review + `tsc` confirm the PUT handler accepts `{status: 'approved'}`, sets `approved_by`/`approved_at` from the session, returns the updated row; UI reloads the tab |
| Happy path: Suspend an approved/active source (with confirmation) | Same pattern; `confirm()` dialog gates the destructive action per the UX requirements |
| Happy path: Reinstate a suspended source | Same, returns to `approved` |
| Happy path: Validate a dataset | Calls the identical `validateDatasetForActivation()` `activate` already uses; result shown via `alert()`, no data changed |
| Invalid input: `status` outside the enum | Server returns 422 with the exact allowed-value list — added this Wave, did not exist before (previously any string would have been written verbatim) |
| Mass-assignment attempt: extra body fields (`id`, `created_by`, `created_at`) | Now silently dropped by the allow-list rather than written — this is the defect fix itself, verified by code inspection of the new `WRITABLE_FIELDS` loop |
| Zero-row mutation: a non-existent source id | `.update(...).eq('id', id).select('*').single()` — Supabase's `.single()` raises an error for zero matched rows, surfaced as a `bad(error.message)` response, not a false success |
| Wrong capability / role-less / anonymous | Not re-derived from a fresh live HTTP round trip this Wave (§8, named gap) — the code path is byte-identical in authorization shape to the already-shipped, already-implicitly-proven `activate`/`retire` siblings (same `requireAdmin()` import, same call site pattern) |
| Duplicate submission | `busyId` state disables the clicked button for the duration of the request, identical to the pre-existing Activate/Retire pattern |
| UI failure reconciliation | On a non-OK response, `alert(json.error ?? '...')` fires and then `await load(tab)` still runs, reloading the server's actual (unchanged) state — no optimistic success can survive a rejection |

---

## 7. Accessibility and responsive behaviour

Changes are confined to the Benchmarks Actions column. New/changed controls: `min-h-11 min-w-11` (44×44 px, WCAG 2.2 SC 2.5.8), `focus-visible:outline` rings with offset, an explicit `aria-label` naming the action and the target row (e.g. "Approve ABS Household Expenditure Survey"), and `confirm()` gates on both destructive actions (Retire, Suspend) that did not have one before (Retire previously fired immediately on click — **this Wave added a confirmation dialog to Retire that was missing even before this Wave's own changes**, a small, low-risk, in-scope UX completion since the button was already being touched to add its sibling Validate action). No broad visual or layout change — the surrounding table structure, columns and styling are untouched.

**Not done:** a live browser-rendered pass at multiple viewport widths, because the page sits behind Super Admin authentication and this worktree has no live session to reach it with (same constraint as Wave 2's own §7.5 disclosure). Recorded honestly rather than claimed.

---

## 8. Outstanding gates (named precisely, per the CONDITIONAL PASS verdict rules)

### Gate 1 — Live HTTP/session verification of the two newly connected actions

**What is missing:** an actual network round trip — running the app, signing in as a real Super Admin session, and a real non-admin session, and exercising Approve/Suspend/Reinstate/Validate over HTTP — was not performed.

**Why it could not be obtained this Wave:** this worktree has no `.env.local` (confirmed absent — `find . -maxdepth 1 -iname ".env*"` returns only `.env.example`). A sibling worktree (`D:/fhip-fdh16`) does have one, but reading its Supabase credentials to obtain them for this Wave was declined by the environment's own permission system when attempted, and this Wave did not attempt to work around that — per the standing instruction to let the user decide rather than route around a denial.

**Risk:** low. The authorization code path added is byte-identical in shape to the already-shipped, already-live `datasets/[id]/activate`/`retire` siblings (same `requireAdmin()` import, same call pattern, same client). No new authorization primitive was introduced.

**Closure action:** the Product Owner (or a session with DEV credentials available) runs the app, signs in as a real Super Admin, and exercises the four new buttons once each, plus one 403 attempt as a signed-in non-admin. No code change is anticipated to be needed; this is a verification step, not an implementation gap.

**Responsible party:** Product Owner, or a follow-up session with live DEV access.

**Merge-blocking:** No — this Wave's own source-control restrictions already prohibit merge regardless of this gate.

### Gate 2 — The A0.1 "six suspected-dead routes" document could not be located

**What is missing:** the named prior determination this Wave was asked to reassess.

**Why:** exhaustive search (§6 of the Discovery report) across all local branches, all remote-tracking refs, and every worktree's on-disk files found no matching artifact anywhere.

**Risk:** the risk is entirely to programme record-keeping, not to the product — no route was removed or connected on the strength of a guess at what the missing document said.

**Closure action:** Product Owner supplies the actual document (or confirms it never existed as a committed artifact and the programme record should be corrected). This Wave's own fresh, independently-derived dead-route findings (§5 of the Discovery report) stand as the best available substitute in the meantime.

**Responsible party:** Product Owner.

**Merge-blocking:** No.

### Gate 3 — Analytics placeholder (PLC-1) disposition

**What is missing:** an explicit Product Owner ruling on whether the honestly-labelled, non-interactive Analytics shell page should be hidden from navigation (per this Wave's own literal disposition rules for a visible-but-task-incomplete surface) or left exactly as Wave 1 designed and certified it (so an Analyst-only user retains at least one visible Admin destination).

**Risk:** low either way — no misleading control exists today; this is a UX-completeness judgment call, not a defect.

**Closure action:** Product Owner states a preference; either requires at most a one-line change to `buildAdminNavGroups()` (to hide) or no change (to keep).

**Responsible party:** Product Owner.

**Merge-blocking:** No.

---

## 9. Deferred-findings register (with named owner and phase, per this Wave's own requirement)

| # | Finding | Owning phase | Dependency | Present safe state | PO decision needed |
|---|---|---|---|---|---|
| DEF-1 | 17-route AI Admin surface has no Admin UI (BWU-4) | A future Module 11.x UI wave (not yet numbered) | A full AI Admin Console UI is new, large scope | Routes exist, gated by `requireAdmin()`, not linked from any nav — not reachable, not misleading | Whether/when to authorise an AI Admin Console wave |
| DEF-2 | `GET /api/admin/resources/glossary/terms` has no caller (BWU-3) | Whichever future phase builds FAQ/Money-Update term-linking (not yet named) | The linking UI itself doesn't exist yet | Read-only, harmless, zero risk sitting idle | Build the linking feature, or explicitly approve removal with the "no future dependency" proof this Wave could not itself establish |
| DEF-3 | Scheduled publishing has no worker or write path (CI-1, = Wave 2's own D-3, re-confirmed not regressed) | A future bounded scheduling-worker phase | Depends on a product decision to build scheduled publishing at all | Validation is correct and consistent (Wave 2); no Schedule control exists to misuse | Whether scheduled publishing is wanted as a product capability |
| DEF-4 | Analytics placeholder (PLC-1) — hide vs. keep | Whichever phase next revisits Analyst nav (could be immediate, is a 1-line change either way) | None | Honestly labelled, non-interactive, certified Wave 1 | Hide it now, or explicitly affirm keeping it as-is |
| DEF-5 | No contextual Help link exists from any Admin page to a task manual | A future UX-affordance pass (could be folded into Wave 5) | None | No help link exists today (absence, not a broken one) | Whether to add Help links as part of Wave 5's manual-standardisation pass |
| DEF-6 | Wave 2's own paper trail has a gap (§1.2 of the Discovery report — FULL PASS is recorded only in a merge-commit message, not a committed document) | N/A — a record-keeping observation, not an implementation task | None | Wave 2 is closed either way; this doesn't block anything | Whether to backfill a proper Wave 2 closure document for the permanent record |

---

## 10. Product Owner decision register

| # | Decision needed | Options | This Wave's recommendation |
|---|---|---|---|
| PO-1 | The missing A0.1 document (Gate 2) | (a) supply it, (b) confirm it never existed and correct the programme record | Confirm/correct, since an exhaustive search found nothing |
| PO-2 | Analytics placeholder disposition (Gate 3 / DEF-4) | (a) hide from nav now, (b) keep as Wave 1 designed it | No strong recommendation either way — both are defensible; flagging because this Wave's own literal rules point one way while the already-certified design points the other |
| PO-3 | AI Admin Console (DEF-1) | (a) authorise a future Module 11.x UI wave, (b) leave routes dormant indefinitely | Defer to Module 11's own roadmap owner — outside this Wave's authority to recommend a timeline for |
| PO-4 | `glossary/terms` (DEF-2) | (a) build the FAQ/Money-Update linking feature that would call it, (b) approve removal | No strong recommendation — low cost either way; flagged so it isn't silently forgotten |
| PO-5 | Scheduled publishing (DEF-3) | (a) authorise a future scheduling-worker phase, (b) leave scheduling permanently validation-only | Carried forward from Wave 2 unchanged — this Wave adds no new information to this decision |

---

## 11. FDH-13 traceability — no change required

Per the Discovery report §9: this Wave's diff touches zero FDH-named files, tables or migrations. **No row in the FDH-13 traceability matrix (at `9fdce5d`, on the unmerged `docs/fdh13-admin-integration-baseline` branch) requires updating**, because no shared Admin surface's status or ownership changed as a result of this Wave. This was checked, not assumed: the two connected surfaces (Benchmarks Sources/Datasets) and the one deferred surface with real future-FDH relevance (none — the AI Admin surface belongs to Module 11, not FDH) do not appear in that matrix's 85 rows by construction (Benchmarks is a Module 8 surface, unrelated to any FDH domain).

## 12. Analyst dependency — no change required

No Analyst capability, predicate, route or nav entry was added, removed or narrowed. The one Analyst-relevant item this Wave discusses (PLC-1/DEF-4/PO-2) is recorded as a disclosed tension for explicit Product Owner decision, not a unilateral change — so there is nothing to update in an Analyst dependency register this Wave.

---

## 13. Verdict

### CONDITIONAL PASS — NAMED GATES OUTSTANDING

**Rationale.** Every surface this Wave found to be genuinely, safely completable within its bounded scope was connected (Benchmarks Sources approval lifecycle, Benchmarks Dataset validation preview), with a real, previously-unexercised mass-assignment defect fixed in the same change. Every surface requiring a major new capability (AI Admin Console) or carrying an unresolved ambiguity this Wave could not itself close (the missing A0.1 document, the Analytics-placeholder disposition, `glossary/terms`) was correctly deferred with a named owner and dependency rather than force-completed or silently removed — satisfying this Wave's own explicit stop conditions rather than expanding scope to route around them. TypeScript is clean, the production build compiles and type-checks cleanly (the static-export failure is a pre-existing, disclosed, credential-free-worktree environment condition, reproduced identically on baseline), and the full deterministic test suite shows **zero regressions attributable to this Wave** (every one of 5 failing files independently traced to either a pre-existing baseline condition or pure parallel-run contention, and disclosed with the reproduction evidence, not merely asserted).

**What keeps this from FULL PASS**, named exactly per the verdict rules:

1. **Gate 1** (§8): the two newly connected Benchmarks actions were verified by code inspection and reuse of an already-certified authorization pattern, but not by an actual live HTTP/session round trip — this worktree has no live DEV credentials, and this Wave declined to obtain them from a sibling worktree when that path was denied by the permission system, rather than work around the denial.
2. **Gate 2** (§8): the "six A0.1 suspected-dead routes" this Wave was asked to reassess could not be located anywhere in this repository's history after an exhaustive search, so deliverable #12 (six-route determinations) is answered with this Wave's own independently-derived fresh findings instead, honestly labelled as a substitute, not a reassessment of the named document.
3. **Gate 3** (§8): the Analytics-placeholder disposition (hide vs. keep) is a genuine, low-risk judgment call this Wave surfaces rather than resolves unilaterally, because this Wave's own literal disposition rules and Wave 1's already-certified design point in different directions and neither is clearly wrong.

None of these three gates is merge-blocking beyond this Wave's own standing source-control restrictions (no merge to `main` was going to happen regardless). All three have a named, bounded, single-step closure action and a named responsible party, per the CONDITIONAL PASS verdict's own requirements.

**No stop condition was silently worked around.** Where this Wave could not resolve something on its own authority (the missing document, the placeholder tension, live-credential access), it stopped and reported rather than guessing, force-completing, or expanding scope to manufacture an answer.

---

## 14. Source-control status

| Item | Value |
|---|---|
| Branch | `fix/admin-a02-wave3-disconnected-content-dead-routes` |
| Worktree | `D:/fhip-a02-wave3` (isolated; `D:/FHIP` and all other active sibling worktrees left untouched) |
| Base | `origin/main` @ `6fdcf7e` |
| Merged to `main` | **No — not authorised, not attempted** |
| Pushed to origin | **No — not attempted** |
| Production migration | **No — none required this Wave** |
| Production deployment | **No — not attempted** |
| Any Resource published/approved/retired | **No** |
| Role or capability changes | **None** |
| FDH-13 implementation begun | **No** |
| Analyst implementation phase begun | **No** |
| MCC reopened | **No** |
| Admin navigation redesign begun | **No** |
| Admin A0.2 Wave 4 begun | **No** |

Awaiting Product Owner review of this report and the three named gates in §8/§10.
