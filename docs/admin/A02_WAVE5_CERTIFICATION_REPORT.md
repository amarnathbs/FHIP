# Admin A0.2 Wave 5 — Current Admin UX Consistency and Manual Validation

## Certification Report

**Branch:** `feature/admin-a02-wave5`
**Worktree:** `D:/FHIP/.claude/worktrees/agent-a0422d78c71c7a2d1` (isolated, created fresh for this Wave)
**Base SHA:** `0e2103904b989e16021ba5f8e74b5dfbb0e49d0a` (`origin/main`)
**Date:** 2026-09-02 / 2026-09-03
**Companion documents:** `A02_WAVE5_UX_INVENTORY_AND_CLASSIFICATION.md` (deliverables 4–12, 18); `A02_WAVE5_ADMIN_TASK_MANUALS.md` (deliverables 17–19, and the terminology register)

---

## 1. Start gate (§2) — reconciled, not assumed

| # | Gate requirement | Result |
|---|---|---|
| 1 | Fetch and prune all remotes | Done. One remote (`doclife`) points at a deleted worktree and fails to fetch — pre-existing, unrelated, recorded not hidden. `origin` fetched cleanly. |
| 2 | Record current `origin/main` | `0e2103904b989e16021ba5f8e74b5dfbb0e49d0a` |
| 3 | Confirm Wave 4 final SHA `5a29b1e` | **Confirmed an ancestor of `origin/main`** (`git merge-base --is-ancestor 5a29b1e origin/main` → exit 0) |
| 4 | Confirm Wave 4 merged and released | Confirmed. `0e21039` is itself the merge commit *"Admin A0.2 Wave 4 — Authorization, Audit and Result-State Consistency — FULL PASS"*. Migration `0125` is confirmed applied to **both** DEV and production by the Product Owner. |
| 5 | Confirm the dependency-manifest correction is on `main` | **Confirmed.** `f26fd21` (`fix(deps): declare @electric-sql/pglite as a devDependency`) is an ancestor of `origin/main`. Note it appears twice in the history (`f26fd21` and `62f38fc`) — the same one-line fix, landed once directly and once via the Wave 4 branch. Harmless, recorded. |
| 6 | Confirm a clean production build from current `origin/main` | **Obtained** — see §3. A clean `npm ci` (492 packages) followed by `npm run build` succeeds on this branch. It took three attempts across the session; the first two were defeated by machine contention, not by the code (§9). |
| 7 | Confirm no Wave 4 residual blocks UX or manual validation | Confirmed. Wave 4's open residuals are audit-coverage classifications and a correlation-ID deferral; none touches presentation, accessibility or documentation. |
| 8 | Fresh branch and isolated worktree from current `origin/main` | Done — `feature/admin-a02-wave5`, created from `0e21039` in a worktree that had never been used for Admin work. |
| 9 | Do not reuse any earlier branch | Confirmed — no Admin, Analyst, FDH, MCC or Module 11 branch was checked out or merged in. |

**Wave 4 behavioural proof against production** was not attempted, and could not be: neither this session nor the coordinating session holds production administrator credentials. This is consistent with §23.2, which directs Wave 5's own browser testing at **DEV**, and with §29's prohibition on touching production. It is recorded here so it is not later mistaken for something this Wave verified.

**`origin/main` moved during the privacy-closure round — assessed, not ignored.** It was `0e21039` when this Wave started and at the end of the first round. By the end of the closure round it was **`bd45308`**, six commits ahead:

```
bd45308 fix(LR-FI-1): declare `owner` on the three wealth row types
3fa1400 fix(LR-FI-1): isolate SMSF-owned rows from household operating cash flow
88eee33 merge: II-PC1-F2 — R6 Stale Engine-Version Consumer Review — UNCONDITIONAL FULL PASS
7023f74 docs(ii-f2): justify lexicographic computed_at comparison in the selector
e039776 test(ii-f2): clean up the synthetic scheme the live-DEV suite creates
21db12c fix(ii-f2): select only the current R6 tax computation for persisted consumers
```

§27 names this as a stop-and-report condition, so it is reported rather than absorbed. **It is not material to Wave 5:**

- Those six commits touch **13 files** (Investment Intelligence tax-result selection, and SMSF/household cash-flow isolation). Wave 5 touches **47**. The intersection is **empty** — verified by set intersection of the two file lists, not by inspection.
- **Neither side adds a migration** (`git diff --name-only -- supabase/migrations` is empty for both), so the migration-collision pattern that has bitten this repository seven times is not in play.
- No Admin page, Admin API route, capability, navigation entry or authorization path is touched by either side.
- `git merge-tree --write-tree origin/main HEAD` exits **0** — a merge would apply cleanly with no conflict.

Wave 5's certification therefore still holds against current `origin/main`. This branch was **not** rebased or merged, per §29; the Product Owner may merge from `bd45308` without reconciliation work.

---

## 2. What this Wave changed, and what it deliberately did not

**Exact changed-file diff (deliverable 26):** **44 files — 37 modified, 7 added, 0 deleted, `+5866 / −755`** (the added total is dominated by the three documentation files and the two new test files).

The single most useful scope fact:

```
git diff --stat -- supabase/ app/api/     ->  (empty)
```

**Zero changes under `supabase/` and zero under `app/api/`.** No migration, no schema, no grant, no policy, no RPC, no route handler, no authorization decision, no HTTP status contract. Every Wave 1–4 database invariant and every Wave 4 audit and authorization contract is therefore preserved by construction, not by assertion.

Migration controls, run anyway per the standing instruction:

```
node scripts/check-migration-versions.mjs
  -> OK: 122 active migrations, one file per version, next version is 0127.
node scripts/check-migration-versions-against-branch.mjs --against=origin/main
  -> OK: no cross-branch migration collisions between "HEAD" (122) and "origin/main" (122).
```

Per §25, **no migration was required and none was created**; no number was allocated, speculatively or otherwise.

### 2.1 New files

| File | Purpose |
|---|---|
| `lib/resources/admin/resultState.ts` | The client-side half of Wave 4's result-state taxonomy: classifies a fetch outcome into one named state, and is the single choke point refusing to display engine-shaped strings. |
| `components/admin/AdminActionStatus.tsx` | The shared "did my change actually commit?" live region — `role="status"` for success, `role="alert"` for failure. |
| `components/admin/AdminTaskHelp.tsx` | The one consistent Help affordance, a native `<details>` disclosure. |
| `lib/admin/taskHelp.ts` | The Help content registry, keyed by the same `ADM-nn` ids as the operator manual. |
| `tests/unit/adminA02Wave5ResultStateAndHelp.test.ts` | Focused unit coverage for all of the above, plus the Admin-surface invariants this Wave establishes. |
| `tests/e2e/admin-a02-wave5-ux.spec.ts` | Real-browser role matrix, responsive certification and focus/confirmation certification against DEV. |
| The three `docs/admin/A02_WAVE5_*.md` documents | Inventory, manuals, this report. |

### 2.2 Boundaries held (deliverables 22–25)

| Boundary | Confirmation |
|---|---|
| **FDH-13** (§20) | Zero files under `lib/financial-data-hub/`, zero `fdh_*` migrations, zero FDH governance pages, zero FDH navigation, no domain-neutral roles, no permanent Super Admin FDH allocation. The FDH-13 baseline at `9fdce5d` was not read into, merged from, or updated. The shared Help and manual patterns this Wave establishes are available for FDH to reuse later, which §20 explicitly permits. |
| **Analyst** (§13) | Analyst remains strictly read-only. No Analyst capability was added, removed or widened. The Analytics destination is still absent from navigation and still shows no figure of any kind. The one Analyst-facing change is the Resources dashboard's Analyst state becoming an explicit, honest `unavailable` state instead of an unlabelled card — a presentation change that grants nothing. **No fake analytics were created to give the Analyst a destination.** |
| **AI Admin** (§21) | Zero AI Admin pages built. No quota, routing, Insight Pack or question-library logic touched. No hidden AI route exposed. Confirmed by direct inspection that there is still no page under any `ai`-named admin route, so there was no visible AI Admin surface to assess. |
| **Scheduled publishing** (§22) | Wave 2's scheduling validation is byte-identical. No Schedule control was added — there was none to hide. No worker, queue or scheduling control was created. The workflow panel and ADM-10's manual entry both state on screen that scheduling is unavailable and that Publish Now takes effect immediately. Deferred to A3.1. |
| **Navigation / Admin shell** (§5) | `lib/admin/adminNav.ts` and `components/ui/AppShell.tsx` are **unmodified**. No navigation was reorganised, no group added or removed, no homepage or dashboard built. |
| **Roles and capabilities** (§3) | No role created. No capability created. No capability's role mapping changed. |

---

## 3. Test, lint, type and build results (deliverables 27, 31, 32)

All of the following were run from a **clean `npm ci` install** in this worktree (492 packages, exit 0).

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **0 errors, exit 0** |
| Production build | `npm run build` | **exit 0** — `✓ Compiled successfully in 47s`, all routes emitted |
| Wave 5 focused suite | `npx vitest run tests/unit/adminA02Wave5ResultStateAndHelp.test.ts` | **24/24 passed, exit 0** |
| Full deterministic suite | `npm test` | 242 files: **237 passed, 4 failed, 1 skipped**. 5875 tests: **5866 passed, 4 failed, 5 skipped** |
| ESLint (changed files) | `npx eslint` over every file this Wave touched | **0 errors, 0 warnings** |
| ESLint (repository-wide) | `npx eslint .` | 102 problems (36 errors, 66 warnings) — **zero in any file this Wave touched**, verified by set intersection of the 33 flagged files against the 46 changed files |

**TypeScript is a meaningful result here, not a formality.** Making `is_featured` part of the editor patch initially produced **15 real type errors** across four scripts and three existing test files that build the patch literally. That is exactly the signal the type system exists to give, and it changed the design — see §7, PO5-5.

### 3.0 Privacy-closure round (2026-09-03) — supersedes the figures below

The Product Owner returned Wave 5 as **CONDITIONAL PASS — ONE P1 PRIVACY GATE OUTSTANDING** (Recommendations Gap Review exposing one identified person's financial figures to a standing Super Admin session). That closure is implemented and certified in `A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md`. Re-run results after it:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors, exit 0** |
| `npm run build` | **exit 0** — `✓ Compiled successfully in 96s` |
| Gap-privacy suite (new) | **11/11 passed** |
| Wave 5 focused suites (both) | **35/35 passed** |
| ESLint over all changed files | **0 errors, 0 warnings** |
| Live browser suite | **16 tests: 15 passed + 1 corrected then passed** — see §4.3 |
| Full deterministic suite | 243 files, 5886 tests — see §3.1 |

**§3.1's reconciliation of the older 5,875 figure is retained below**, because the Product Owner asked specifically how nine non-passing tests mapped to four files, and that question is about that run.

### 3.1 Full-suite arithmetic, reconciled

**Files**: 242 discovered = 237 passed + 4 failed + 1 skipped.
**Tests**: 5875 discovered = 5866 passed + 4 failed + 5 skipped. Not executed: 0.

The 4 failing files split into two distinct groups, and neither is Wave-5-attributable:

**Group A — 2 genuinely pre-existing deterministic failures**, the same two Wave 4 documented and independently reproduced against real `origin/main`:
- `tests/unit/aiResidualClosureFailClosed.test.ts` (test A4, Module 11 AI-context certification)
- `tests/unit/resourcesR1_1.test.ts` (a 5000ms timeout in Resources CMS isolation)

Both files, and the production code they exercise, are **byte-identical to `origin/main`** — `git diff origin/main --name-only` over them returns empty.

**Group B — 2 live-DEV tests that fail only under concurrency**:
- `tests/unit/resourcesAdminR1_2.test.ts` ("draft count increases by exactly 1")
- `tests/unit/resourcesDiscoveryR1_6LiveDev.test.ts` ("archiving a related target makes it disappear")

Both assert **counts against the shared live DEV database**, while the rest of the suite is concurrently creating and deleting fixtures in that same database — and other sessions on this machine were doing the same. Re-run in isolation they pass: `npx vitest run` over just those two files gives **2 files / 51 tests, all passed, exit 0**. Both files and their production code (`lib/resources/admin/queries.ts`, `lib/resources/discovery/`) are also **byte-identical to `origin/main`**.

An earlier full-suite run in the same session, before the save-integrity fix, showed only Group A failing (239 passed / 2 failed), which is consistent with Group B being timing-dependent rather than caused by any change.

**Reconciliation verdict: zero Wave-5-attributable test regressions.**

### 3.1a Answering the question directly: where did the nine go?

The Product Owner asked how nine non-passing tests map to four files in the `5,866 / 5,875` run. They do not — and that is the point of the question.

```
5,875 total = 5,866 passed + 4 failed + 5 skipped
                             └── 9 not passing ──┘
```

The nine are **two different populations**, not one:

| Population | Count | Files | Nature |
|---|---:|---|---|
| Failed | 4 | 4 files, exactly 1 failing test each | 2 pre-existing deterministic, 2 live-DEV concurrency |
| **Skipped** | **5** | `iiR4LiveIntegration.test.ts`, `resourcesR1_7DFinalLiveDev.test.ts` | **Deliberate standing `describe.skip` / `skipIf` guards** on live-integration tests |

So the four files account for the four *failures*; the remaining five are intentional skips in two entirely different files and were never expected to run. Additionally 1 whole **file** is skipped, which is why `242 = 237 passed + 4 failed + 1 skipped`.

**Pending: 0. Not executed: 0.** Every discovered test reached a terminal state.

### 3.1b Authoritative run after the privacy closure

Re-run with `.env.local` present (so the live-DEV suites load rather than crashing at import):

```
Test Files  5 failed | 237 passed | 1 skipped (243)
     Tests  2 failed | 5,808 passed | 76 skipped (5,886)
```

| Bucket | Count | Accounting |
|---|---:|---|
| Passed | 5,808 | |
| **Failed** | **2** | `aiResidualClosureFailClosed` (A4) and `resourcesR1_1` — the two genuinely pre-existing failures Wave 4 reproduced against real `origin/main`. Both files byte-identical to `origin/main`. |
| **Skipped** | **76** | **71** of these are three live-DEV suites whose `beforeAll` threw, so vitest marks every test in them skipped: `resourcesAdminR1_2` (26) + `resourcesDiscoveryR1_6LiveDev` (25) + `resourcesR1_4LiveDev` (20) = 71. Plus the same **5** standing `skipIf` guards as before. 71 + 5 = 76. ✓ |
| Pending | 0 | |
| Not executed | 0 | |
| **Total** | **5,886** | 5,808 + 2 + 76 ✓ |

Files: 243 = 237 passed + 5 failed + 1 skipped ✓. The file count rose 242 → 243 because this round added `adminA02Wave5GapPrivacy.test.ts`.

**Why those three suites threw — established from the error text, not inferred:**

```
Error: Failed to verify OTP for analyst: Request rate limit reached
Error: Failed to verify OTP: Request rate limit reached
```

All three create **real users against the shared DEV Supabase project** and hit Supabase Auth's rate limit — reached because the rest of the suite creates users concurrently, this Wave's browser suite creates eight fixtures per run, and other sessions on this machine target the same project. It is an auth quota, not a code path.

**Proven by isolation, not asserted:** re-running exactly those three files alone gives **3 files / 71 tests / all passed / exit 0** — the same 71 that the full run marked skipped. All three files are byte-identical to `origin/main`.

Two further files (`countryGateAccessMatrix`, `fdh11Isolation`) failed in an intermediate run on a 5,000 ms default timeout while walking the filesystem under load; both pass in isolation and neither appears in the authoritative run.

**Every claimed pre-existing or environmental result above was reproduced, not assumed:** by byte-identity against `origin/main` for all five files, and by isolation re-runs for the four non-deterministic ones.

### 3.2 What the focused suite covers

1. **Result-state classification** — every named HTTP outcome maps to its own state; nothing non-retryable is ever offered a Retry; nine real engine-shaped strings (RLS violations, constraint names, function signatures, `SyntaxError`, `Failed to fetch`, `PGRST116`) are each proven not to reach the screen; a curated message still passes through unchanged; `readJsonSafely` returns null rather than throwing on an HTML error page.
2. **Help registry** — internal completeness of all 21 entries; unavailable tasks carry a reason and **no steps**; no route, RPC, table or repository path appears in any operator-facing string; every registry task has a manual section and every manual section resolves to a registry entry; every `taskId` referenced by a component exists, including the two components that choose theirs dynamically.
3. **Admin-surface invariants** — no native `alert`/`confirm` anywhere in Admin; the confirm dialog traps and restores focus and defaults to the safe choice; the two helpers that fed raw Postgres text to the screen no longer do while the RPC's own authored messages still pass through; the error boundary shows a digest not a message; the editors actually send the Featured field; one save label across four editors with the shared panel agreeing; publishing carries confirmation naming the real effect; the mutations that ignored their responses now check them; **a save requested during an in-flight save is queued rather than dropped, and no editor claims "Saved" for content that changed while the request was in flight** (all four editors).

The focused suite covers, in three groups:
1. **Result-state classification** — every named HTTP outcome maps to its own state; nothing non-retryable is ever offered a Retry; nine real engine-shaped strings (RLS violations, constraint names, function signatures, `SyntaxError`, `Failed to fetch`, `PGRST116`) are each proven not to reach the screen; a curated message still passes through unchanged; `readJsonSafely` returns null rather than throwing on an HTML error page.
2. **Help registry** — internal completeness of all 21 entries; unavailable tasks carry a reason and **no steps**; no route, RPC, table or repository path appears in any operator-facing string; every registry task has a manual section and every manual section resolves to a registry entry; every `taskId` referenced by a component exists.
3. **Admin-surface invariants** — no native `alert`/`confirm` anywhere in Admin; the confirm dialog traps and restores focus and defaults to the safe choice; the two helpers that fed raw Postgres text to the screen no longer do while the RPC's own authored messages still pass through; the error boundary shows a digest not a message; the editors actually send the Featured field; one save label across four editors with the shared panel agreeing; publishing carries confirmation naming the real effect; the mutations that ignored their responses now check them.

---

## 4. Browser test results (deliverable 28) — §23.2, §23.3

`tests/e2e/admin-a02-wave5-ux.spec.ts` targets the running application against **live hosted DEV**, and refuses to start if `NEXT_PUBLIC_SUPABASE_URL` is not the known DEV project — a hard guard, not a convention.

It creates **eight** uniquely-prefixed fixture accounts (`a02w5-<stamp>-<role>@fhip-test.invalid`) with real `resource_user_roles` rows, drives the real login form, and asserts:

- role-less account sees **no** Admin destinations;
- Author sees content and workflow destinations and **not** Benchmarks or Recommendations;
- Analyst-only sees the honest non-interactive notice and **zero** clickable destinations;
- Analyst is read-only on the dashboard and is offered **no** create action;
- Author + Editor receives the union of both and gains **no** unrelated authority;
- a direct URL to a Super Admin page is refused for a Resources role;
- a direct URL to role management is refused for a role that cannot manage roles;
- the Help disclosure exists and is operable from the keyboard alone;
- a non-manager receives an explicit `403` from the users endpoint, not an empty success;
- **no page-level horizontal overflow** across 11 Admin pages × 5 widths (320/375/768/1024/1280) = 55 measurements;
- Admin pages reflow at 200% zoom;
- a destructive action confirms, the dialog names the object and effect rather than asking "Are you sure?", focus starts on **Cancel**, Tab cannot escape the modal, and Escape restores focus to the opener.

`afterAll` deletes every role row and every auth user, then **re-queries** each one and fails the run if any residue remains (§24).

### 4.1 Result: 12 / 12 passed, zero residue

```
Running 12 tests using 1 worker
  ok  1  an account with no Resources role sees no Admin menu at all
  ok  2  Author sees content and workflow destinations, and no Super Admin destinations
  ok  3  Analyst-only sees no operational destination and is told so honestly
  ok  4  Analyst is read-only: the Resources dashboard offers no create action
  ok  5  Author + Editor receives the union of both roles, and gains no unrelated authority
  ok  6  a direct URL to a Super Admin page is refused for a Resources role
  ok  7  a direct URL to role management is refused for a role that cannot manage roles
  ok  8  the Help disclosure exists, is keyboard-operable, and states the next step
  ok  9  a permission denial renders as a non-retryable state, not a red "try again"
  ok 10  no Admin page overflows horizontally at any tested width      (55 measurements)
  ok 11  Admin pages remain usable at 200% zoom
  ok 12  a destructive action confirms, traps focus, and restores it on cancel
WAVE 5 CLEANUP: residue=0 (0 expected)
```

Test 10 is reported from its own dedicated re-run (4.0m) after being raised above a harness timeout; the other 11 are from the same 12-test run. All 55 responsive measurements pass.

### 4.2 Four harness defects found and corrected before any result was believed

This matters, because each would otherwise have been reported as a product defect that does not exist:

1. **Login never submitted.** The form's `onSubmit` prevents default only after React hydrates; under Turbopack dev on a contended machine the click landed first and the browser performed a **native GET submit** to `/login?`. The tell was the empty query string — the inputs carry no `name` attribute, so a native submit serialises nothing. A `toHaveValue` check does NOT prove hydration (`fill()` writes the DOM value directly); the spec now waits for React's own `__reactFiber$…` keys on the submit button.
2. **The Admin menu looked empty for every role.** The shell resolves capabilities client-side after the dashboard renders, so sampling immediately reported "no destinations". Confirmed against the real UI that an Author sees exactly the 16 correct destinations and no Super Admin ones. The helper now waits.
3. **The Analyst case was asserted wrongly by the harness.** For Analyst the menu correctly opens and is correctly *empty*; requiring a menu item there failed on correct behaviour.
4. **The Help test focused a `<span>`, not the `<summary>`**, so Enter could never toggle the disclosure.

A fifth environmental trap was diagnosed rather than misreported: running `next dev` over a `.next` directory containing **production** build output serves 404s for every client chunk, so nothing hydrates. Clearing `.next` between a build and a dev run resolved it.

### 4.3 A sixth harness defect, found in the privacy round — and it was nearly reported as a leak

The privacy round added a test asserting that the Recommendations page's served HTML contains no sensitive field name. **It failed**, reporting `served HTML must not contain monthly_surplus`.

That looked like a privacy leak. It was not, and confirming which took precedence over everything else.

`/admin/recommendations` is Super-Admin-only and **redirects a non-Super-Admin to `/dashboard`**. The test logged in as a Resources role, so the HTML it scanned was **the fixture's own dashboard** — where their own `monthly_surplus` legitimately appears, because a person is entitled to see their own figures. The assertion was scanning a page it never reached.

The test now asserts what it can honestly prove from a browser: that a non-Super-Admin **cannot reach the page at all**. The Recommendations page's own rendered output is deliberately not browser-verified, because no fixture in this suite holds Super Admin — granting real Super Admin to a synthetic account is a larger risk than the coverage it buys. That surface is covered by the unit suite (the client holds no gap state, issues no gap request, renders no snapshot) and, decisively, by the API tests proving the data cannot be served to **any** role.

Recorded prominently because it is the failure mode this Wave's whole method is meant to catch: a red test that names a real-sounding privacy defect, which on inspection is the harness testing the wrong page.

---

## 5. Accessibility findings and fixes (deliverable 29) — §11

Manual inspection, not automation alone, as §11 requires. Every finding and its disposition is in the classification register (UX-27 to UX-34, UX-36, UX-50). Summary of what changed:

| WCAG 2.2 AA area | Before | After |
|---|---|---|
| Status announcements for asynchronous results | **No `aria-live` region anywhere in Admin.** Filtering, paging, result counts and every mutation outcome were silent | A live region on every list and every mutating surface; success is `role="status"`, failure is `role="alert"` |
| Focus movement after modal open/close | Dialog declared `aria-modal` but Tab escaped it; focus never returned to the opener; ids hardcoded despite two dialogs being mounted at once in every editor | Focus trap with wrap-around, focus restoration (guarded against a detached opener), per-instance ids, and **Cancel** focused by default rather than the destructive action |
| Focus recovery after an action removes a control | Paging onto the last page disabled the focused button, dropping focus to `<body>` | Focus moves to the surviving control |
| No keyboard trap | The Add Block disclosure declared `aria-expanded`/`aria-controls` but Escape did nothing | Escape closes it and returns focus to the trigger |
| Accessible names | Row actions named only "Edit"/"Deactivate"/"Remove"/"Unlink"/"Assign", identical on every row, across five screens | Every row action names the object it acts on |
| Table headers | Benchmarks had no `th scope` and no accessible table name; Users had no `caption` and no `th scope="row"` | Added; the wrong `colSpan` on four Benchmarks tabs also corrected |
| Error association | The CTA form rendered field errors with no `aria-invalid` and no `aria-describedby` | Wired; required fields marked required; an error summary with a count; focus moved to the summary |
| Non-colour status meaning | The compliance badge's visible text was the name of its own colour, with the meaning only in a mouse-only `title` | The meaning is now attached where assistive technology reads it |
| Control target size | ~24px targets on Context Mapping and several shared controls | 44px minimum applied to every control this Wave touched |
| Screen-reader interpretation of icons | A decorative "›" announced before every sidebar section heading | `aria-hidden` |
| Zoom / reflow | Untested | Certified at 200% by the browser suite |
| Drag-only operations | **None existed** — every reorder in Admin is already Up/Down buttons, deliberately. Confirmed, not assumed | Unchanged |

**Not claimed:** this is not a full WCAG 2.2 AA conformance statement for the Admin surface. It is a certification of the areas §11 names, against the screens this Wave inventoried. Colour-contrast ratios were **not** measured instrumentally — the design tokens are inherited from the certified design system and were not changed by this Wave, but "inherited and unchanged" is not the same as "measured", and it is recorded as a residual rather than claimed as tested.

---

## 6. Responsive findings and fixes (deliverable 30) — §12

Two real layout defects were found and fixed:
- **Users & Roles and the CTA list had no layout below `sm`**, so a 320px viewport had to horizontally scroll a table row containing a `<select>` and a button. Both now have card layouts, matching what the content, video, glossary, money-update and FAQ lists already did.
- **All four content editors' header clusters could not wrap.** At around 360px the save-failure state (indicator + explanation + Retry) overflowed. All four now wrap.

Everything else already handled overflow correctly. No Admin page causes **page-level** horizontal overflow; every wide table scrolls inside its own container, which §12 explicitly permits. The browser suite measures this at five widths across eleven pages.

---

## 7. Product Owner decision register (deliverable 38)

| # | Decision needed | Context | This Wave's action |
|---|---|---|---|
| PO5-1 | ~~Should Recommendations Gap review display a real person's evaluated financial figures to a Super Admin at all?~~ | Raised by Wave 5 as a stop-and-report item under §27. | **DECIDED AND CLOSED by the Product Owner: no.** Super Admin must not hold standing access to identifiable individual financial figures through Gap Review, and a caution plus a manual warning was ruled insufficient. Implemented as a fail-closed server boundary — the endpoint issues no query and returns a stable `503` to an authorized Super Admin, while 401/403 precedence is preserved for everyone else. See `A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md`. |
| PO5-2 | **Rename the `General` Admin nav group?** | It holds Benchmarks and Recommendations and describes neither. | **Not changed** — renaming it would alter assertions in the certified Analyst Wave 1 navigation contract and its tests, which §14 places outside a UX Wave's authority. Recorded in the terminology register. |
| PO5-3 | **Rename "Add @GKTC Video"?** | The control label embeds a specific channel handle. Accurate today; couples the interface to one channel. | **Not changed.** Branding decision. Recorded. |
| PO5-4 | **Should the CSV bulk import confirm before it runs?** | It fires the moment a file is selected. It is non-destructive by design, validates every row before writing, and reports exactly what changed. | **Not changed.** A confirmation would be an improvement but is a workflow change, not a safety fix. Recorded in the destructive-action matrix as the one remaining unconfirmed high-impact action. |
| PO5-5 | **Is making the Featured checkbox actually save a UX fix or a business change?** | The checkbox has always been rendered, editable, and silently discarded; the column it targets is live and drives the public Resources landing page's "Start here" cards. | **Changed**, as a `MISLEADING_SUCCESS` fix under §28's "no misleading success remains". No grant, migration or capability change was needed — the column was already in migration `0049`'s `authenticated` UPDATE grant. Flagged here because it is the one change in this Wave with a visible effect on the public site's content selection, and the Product Owner should know that Featured now does what it says. |
| PO5-6 | **Should `adminRoute()`'s catch-all still forward a thrown error's own message?** | `lib/services/adminAuth.ts`'s wrapper returns `err.message` on an uncaught throw — the same class of leak Wave 4's own G6 gate closed everywhere else. | **Not changed** — it is Wave 4's own file and its current behaviour is deliberate (it exists to make an Amplify misconfiguration diagnosable from the Network tab). Recorded as a residual for Wave 6 rather than silently altered. |

---

## 8. Deferred-findings register (deliverable 37)

Real findings, deliberately not fixed, with the reason.

| # | Finding | Why deferred |
|---|---|---|
| D5-1 | The Recommendations form uses `placeholder` as the only label on roughly 20 inputs | Relabelling is a form redesign, not a consistency pass. This Wave labelled the filter and search controls on that page and left the form. |
| D5-2 | `FormField`'s required asterisk is `aria-hidden` and no input receives `aria-required` | The primitive is shared by every form in the application, well beyond Admin. Changing it needs its own scoped change. |
| D5-3 | No error **summary** in the four content editors, though `validation.ts` documents one as the original design intent, and SEO errors can land inside a collapsed accordion | Adding a summary plus accordion-state signalling to four editors is a bounded but real piece of work; the CTA form now demonstrates the pattern. |
| D5-4 | Date fields are plain text inputs with placeholder-only format guidance | Same reason as D5-2 — shared field primitives. |
| D5-5 | No **Cancel** control in any content editor | Adding one needs a defined discard semantic (revert to last save vs. navigate away), which is a product decision. |
| D5-6 | Live validation fires on untouched, empty new drafts, so a brand-new draft opens covered in required-field errors | Fixing it properly needs touched-state tracking across four editors. |
| ~~D5-7~~ | ~~A debounced autosave colliding with a manual save is dropped silently and never re-armed, and the indicator can read **Saved** while edits are unsaved~~ | **FIXED, not deferred.** Initially recorded here, then reconsidered: §28 forbids FULL PASS while "misleading success remains", and an editor sitting on **Saved** while holding unsaved work is the most consequential misleading success in Admin. All four content editors now queue a save requested during an in-flight one instead of discarding it, and only clear the dirty state when a monotonic edit counter proves nothing changed while the request was in flight. Covered by two new focused tests. |
| D5-8 | The CTA form has no conflict handling; two editors' saves silently last-write-win | Needs a server-side `expectedUpdatedAt` contract the endpoint does not have — a data-contract change. |
| D5-9 | `ChapterEditor` and `AliasesEditor` still have ~24px targets, no focus-visible styling, and no announcement on reorder/add/remove | Both are sub-components of the video and glossary editors; the same treatment applied to Context Mapping should be applied to them next. **These meet WCAG 2.2 AA SC 2.5.8 (24×24 minimum); the 44px used everywhere else in Admin is the stricter house standard, so this is a consistency gap rather than an AA failure.** |
| D5-14 | Text and non-text contrast ratios were not measured instrumentally anywhere in Admin | The design tokens are inherited from the certified design system and unchanged by this Wave. Measuring them is a design-system-wide task, not an Admin-UX one, and would produce findings this Wave has no authority to act on. |
| D5-10 | Five content tables still have no `<caption>` | Small and safe, but not worth adding unverified at the end of a run. |
| D5-11 | Workflow history renders `by unknown role` for the entry you just created, because the optimistic local entry always sets a null actor role | Cosmetic but confusing; a data-shape fix in the editors' optimistic update. |
| D5-12 | `Retry Save` re-saves without creating a version, even when the failed save would have | Narrow; needs the retry to remember the original intent. |
| D5-13 | The `adminRoute()` catch-all forwards a thrown message (PO5-6) | Wave 4's file. |

---

## 9. Environment conditions — recorded, because they shaped the run

Every gate this section originally opened is now **closed**. It is retained because the conditions are real, recurring on this machine, and cost several hours; a later Wave should not have to rediscover them.

### 9.1 Machine contention (resolved by waiting, not by lowering the bar)

For most of this Wave's execution window the machine was running, from other sessions' worktrees against the same disk: **four concurrent `npm ci` processes, three `vitest` runs, an `eslint` run, a `tsc` run and a `next build`**. Under that load:

- a first `npm ci` in this worktree consumed 630+ seconds of CPU and reached ~626MB without completing (diagnosed by watching CPU actually advance — it was slow, not hung);
- a first `next build` flatlined at `Creating an optimized production build …`, the exact point Wave 4 recorded in its own §R3.4;
- the focused unit suite took 282 seconds to fail at *worker startup*.

Interim work therefore borrowed the repository root's installed tree. **That was not accepted as the final evidence.** Once the machine quietened (2 node processes), a real `npm ci` in this worktree completed in **6 minutes, 492 packages, exit 0**, and every result reported in §3 was re-run from that clean install. The build and full-suite gates are closed on that basis, not on the borrowed tree.

### 9.2 The partial-install trap, and what it broke

The abandoned first `npm ci` left a **partial** `node_modules` in this worktree. That is worse than none: Playwright resolved `@playwright/test` from the parent tree but `playwright` from the partial local one, producing `Playwright Test did not expect test.beforeAll() to be called here` — a message that names none of the real cause. Removing the partial tree fixed it. A partial dependency tree should be deleted, not worked around.

### 9.3 Two dev-server traps

- **Port reuse across sessions.** The repository's `playwright.config.ts` sets `reuseExistingServer: true` against port 3000. Another session held 3000, so an unmodified run would have silently certified **another worktree's code**. This run used a dedicated port and a run-specific config with no `webServer` block, and passed the address in explicitly. The config was deleted afterwards and is not in the diff.
- **Mixing build output with dev output.** Running `next dev` over a `.next` directory left by `npm run build` serves 404 for every client chunk, so nothing hydrates and every browser test fails at login for a reason that looks like a product defect. `.next` must be cleared between a production build and a dev run.

### 9.4 One thing this Wave got wrong, recorded rather than quietly fixed

While clearing a poisoned `.next`, this session ran a process kill filtered only on `next dev`, which matched and terminated **dev servers belonging to other sessions on this shared machine**, not just its own. No repository content was affected and those sessions' harnesses restart their own servers, but it was careless: the correct filter is the worktree path, or the PID owning a known port. Every subsequent kill in this Wave was scoped that way. Recorded so the next Wave inherits the rule rather than the mistake.

### 9.5 Still not obtained (and not claimed)

- **Wave 4 behavioural proof against production.** Neither this session nor the coordinating session holds production administrator credentials. Consistent with §23.2 directing Wave 5's testing at DEV, and with §29 forbidding production action.
- **Instrumental colour-contrast measurement.** The design tokens are inherited and unchanged by this Wave, but "inherited and unchanged" is not "measured". Named in §5 and in the deferred register.

---

## 10. DEV data controls (deliverables 33–35) — §24

**Before/after reconciliation.** This Wave performed **no** manual DEV data changes of any kind. No Resource, Recommendation, Benchmark, CTA, FAQ, mapping or role was created, published, approved, altered or deleted by hand at any point.

The only DEV writes this Wave makes are the browser suite's own fixtures, which:
- carry a unique per-run prefix (`a02w5-<timestamp><random>-`);
- are created only as auth users, profile rows and `resource_user_roles` rows — **never** as content, and never against a real user;
- are deleted in `afterAll`, whose deletion is then **independently re-queried** and which fails the run on any residue;
- include the fixture Super Admin path being deliberately **not** used: no fixture is granted `admin_users` membership, so no fixture account ever holds Super Admin. The Super-Admin-only screens are certified structurally and by the unit suite instead. This is a deliberate narrowing — granting real Super Admin to a synthetic account, even briefly, is a larger risk than the coverage it buys.

**Retained certification-artifact register:** none. This Wave intentionally retains **zero** DEV artifacts.

**Fixture-account revocation proof:** the suite's own `afterAll` deletes every `resource_user_roles` row and every auth user it created, re-queries both, logs `WAVE 5 CLEANUP: residue=N`, and asserts `N === 0`. Because no fixture is ever granted Super Admin, there is no `admin_users` row to revoke.

**Credential handling.** The worktree's `.env.local` was created by copying the repository root's, **with every `PRODUCTION_*` variable filtered out**, so the production service-role key was never present in this worktree at any point. The file is covered by `.gitignore` (`.env*.local`) — verified with `git check-ignore -v`, not assumed.

---

## 11. Secrets and scope-contamination results (deliverable 36)

- **Conflict markers:** none. No `<<<<<<<`, `=======` or `>>>>>>>` in any changed file.
- **Secrets:** no key, token or credential appears in any changed or added file. The only environment access in new code is the browser spec reading `.env.local` at runtime, following the exact pattern the existing FDH-14 accessibility spec already uses, with a hard refusal to proceed against any project other than the known DEV reference.
- **Scope contamination:** the diff touches only `components/`, `lib/`, one `app/(app)/admin` error boundary, `tests/` and `docs/admin/`. Zero files under `supabase/`, `app/api/`, `lib/financial-data-hub/`, `lib/admin/adminNav.ts` or `components/ui/AppShell.tsx`.
- **One real contamination caught and reverted.** Running the full test suite rewrote the `generatedAt` timestamp inside `scripts/ii-r5-certification/comparison_report.json` and `scripts/ii-r6p1-certification/comparison_report.json` — a side effect of an Investment Intelligence certification harness, nothing to do with this Wave. Both were staged before it was noticed, and both were reverted (`git restore`), leaving the final diff at 44 files. Worth recording: running `npm test` in this repository mutates two tracked files, so any Wave that runs it must check its own diff afterwards rather than assuming the suite is read-only.
- **`components/resources/admin/ResourceStates.tsx` is shared with the Financial Data Hub** (11 call sites under `app/(app)/financial-data-hub/`). Its existing `ResourceErrorState({ message, onRetry })` signature was preserved exactly, with `title` added as an optional prop defaulting to the original string — so every FDH call site is behaviourally unchanged. This was checked deliberately, because it was the one place a Wave-5 change could have leaked outside Admin.

---

## 12. Verdict

### Admin A0.2 Wave 5 — **FULL PASS — ADMIN A0.2 WAVE 5 COMPLETE**

Checked against §28's own list, one clause at a time:

| §28 requirement | Status |
|---|---|
| Every visible current Admin task inventoried | ✅ All **36 pages** and **21 tasks**, counts recalculated rather than carried forward |
| Every visible task has an understandable purpose and primary action | ✅ Purpose statements went 30/36 → 36/36; the dashboard's create action is no longer offered to roles that cannot create |
| Loading, empty, unavailable, error, validation, conflict and success states accurate | ✅ Full matrix in the inventory document; `forbidden` is now distinct from `error` on every screen |
| **No misleading success remains** | ✅ Nine found, nine fixed — including the Featured field that discarded what it saved, four mutations that ignored their own responses, and the editors that could read **Saved** while holding unsaved work |
| Destructive actions have appropriate confirmation | ✅ Every high-impact action now confirms, naming the object and the effect. The one exception — CSV bulk import — is non-destructive by design, validates before writing, and is disclosed as PO5-4 rather than quietly counted as done |
| Recovery and reversal guidance accurate | ✅ Reversal matrix, and each manual's fields 15–18 |
| Every visible task has a validated manual | ✅ 21/21 in the 24-field structure; Wave 3's deferral of 15 of them is closed |
| Role-by-role behaviour correct | ✅ Proven in a real browser against DEV with real role rows, not mocked arrays |
| Analyst remains read-only | ✅ Verified live: no create action, no mutation, honest unavailable state, no fabricated analytics |
| Accessibility and responsive verification pass | ✅ 12/12 browser tests including 55 responsive measurements, 200% zoom, focus trap and focus restoration. Two residuals disclosed (D5-9 consistency, D5-14 contrast not measured), neither an AA failure |
| Deterministic regression, TypeScript, ESLint, production build pass | ✅ tsc 0 errors; build exit 0 from a clean install; 0 lint problems in every touched file; 4 suite failures all proven non-attributable |
| DEV changes reconcile exactly | ✅ `residue=0`, re-queried rather than assumed. No content, recommendation, benchmark or real user was created, altered or published |
| No active fixture account or unexplained residue | ✅ No fixture was ever granted Super Admin; all fixtures deleted and deletion independently verified |
| No scope contamination | ✅ **Zero changes under `supabase/` and `app/api/`** — no migration, no schema, no authorization decision, no HTTP contract |

### 12.1 The privacy gate (added by the closure round)

| Closure requirement | Status |
|---|---|
| No Admin role can retrieve individual financial figures through Gap Review | ✅ Anonymous `401`, every non-Super-Admin role `403`, Super Admin `503` with no `data` key. Proven behaviourally against the real handler and live against DEV. |
| Hiding navigation cannot be bypassed through the page or API | ✅ The control is the server: the handler **issues no query at all**, asserted by test that no database client is ever constructed. The UI change is a courtesy and would be redundant alone. |
| An honest unavailable state is presented | ✅ On-page notice naming the reason, that it applies to Super Admin too, and the aggregate replacement. No clickable placeholder — asserted by test that the section contains no `<button>`, `<Link>` or `<a>`. |
| Future aggregate implementation is traceable | ✅ `A02_WAVE5_GAP_REVIEW_PRIVACY_CLOSURE.md` §6, ADM-06's manual entry, the Help registry, and the route's own header. Allocated to the canonical Admin Analytics/Privacy phase; nothing scaffolded here. |
| All existing Wave 5 UX fixes remain intact | ✅ Asserted by test: library, editing, activation confirmation, CSV import, announcements and Help all still wired on the same screen. 35/35 focused tests pass. |
| No sensitive figures in reports, logs or fixtures | ✅ No real figure appears in any document, test or fixture. The tests assert field names **absent**; the only values used are synthetic. The handler logs nothing. |

### 12.2 Two things this verdict deliberately does not claim. It is not a full WCAG 2.2 AA conformance statement for the Admin surface — it certifies the areas §11 names, on the screens inventoried, with contrast unmeasured and disclosed. And it says nothing about Wave 4's behaviour against production, which no one in this chain has the credentials to test.

**The single most consequential UX finding** was not a polish item: the four content editors could discard an author's work and then tell them it was saved. That is fixed, and it is the reason a deferral in this Wave's own register was reopened rather than shipped.

**The single most consequential finding overall** was the one this Wave raised but did not have the authority to close — Gap Review handing a standing Super Admin session one identified person's exact surplus, runway and per-category position, 200 people at a time. Wave 5 surfaced it as a stop-and-report item; the Product Owner ruled; it is now closed at the server. Naming it rather than softening it into a caution is what made the ruling possible.

---

## 13. Source-control status (§29)

- **Not merged** to `main`. **Not pushed** to `main`. **Not deployed.**
- No production migration applied. No production data touched. No production request of any kind made.
- A0.2 Wave 6 not begun. A1 not begun.
- Stopping here for Product Owner review, as §29 directs.
