# A2 — Test and Regression Report

## 1. Pinned baseline

**Baseline SHA (pinned for the whole of this pass, per dispatch §27/governance addendum item 3): `a9d09f1`** — the A1 merge commit into `origin/main`. Confirmed via `git fetch origin` during this pass that `origin/main` is *still* exactly `a9d09f1` — no Admin-relevant (or any) commit has landed on `origin/main` since the A1 merge, so this branch's diff against that pinned SHA is the complete, unambiguous set of A2 changes; no moving-target comparison was needed.

## 2. Environment note (read before the numbers below)

This session's shared execution host was observed under heavy concurrent load (multiple unrelated node/npm processes from other sessions/worktrees, one already-running dev server for an unrelated task on the shared preview port). This caused two specific, reproduced-and-explained artifacts documented in §3 below. Every number in this report reflects the **isolated, low-contention re-run**, not the contended one, and both runs are disclosed for transparency.

## 3. Targeted Admin test suite (this branch's new/reconciled A2 files)

First run (concurrent with a background `tsc --noEmit`, i.e. under contention):

```
Test Files  1 failed | 2 passed (3)
     Tests  2 failed | 81 passed (83)
Duration    190.07s (import 190.87s, tests 13.79s)
```

Both failures were `Error: Test timed out in 5000ms` on the exact two tests that call the mocked `redirect()` path in `tests/unit/adminA2HomeRoute.test.ts` ("logged out → /login", "role-less → /dashboard"). Root-caused to CPU starvation, not a code defect: re-run of the same file alone, with no concurrent `tsc` process, completed in **33.88s** with **5/5 passed**. Re-run of the full 3-file targeted suite together, still isolated, completed in **49.15s** with **83/83 passed**, matching the first run's pass count exactly for the 81 tests that were not starved, plus both previously-starved tests now passing.

**Final targeted result: 3 test files, 83 tests, 83 passed, 0 failed, 0 skipped.**

| File | Result |
|---|---|
| `tests/unit/adminA2CanonicalShell.test.ts` | All pass |
| `tests/unit/adminA2HomeRoute.test.ts` | All pass (5 tests) |
| `tests/unit/adminA2NavigationRegistry.test.ts` (new this pass) | All pass |
| **Total (3 files)** | **83 tests, 83 passed, 0 failed, 0 skipped** |

The 83 figure is vitest's own directly-reported total across the 3-file run (`Test Files 3 passed (3)` / `Tests 83 passed (83)`), not a manually re-summed count — the per-file breakdown above intentionally does not assign an exact count to `adminA2CanonicalShell.test.ts` and `adminA2NavigationRegistry.test.ts` individually to avoid restating a number vitest did not itself report per-file in the captured run.

## 4. TypeScript

`npx tsc --noEmit -p .` completed (did not stall). **4 pre-existing errors, none in any A2 file**, all pre-dating this branch:

- `scripts/resources/lib/workbook.ts` — missing `xlsx` type declarations (optional dependency not installed) + 2 implicit-`any` parameters.
- `tests/unit/support/pgliteInsightPackHarness.ts` — missing `@electric-sql/pglite` type declarations (optional dependency not installed).

Neither file is touched by A2. Every file this pass added or edited (`lib/admin/adminAreas.ts`, `lib/admin/homeQueues.ts`, `lib/admin/navigationRegistry.ts`, `components/admin/AdminShell.tsx`, `app/(app)/admin/layout.tsx`, `app/(app)/admin/home/page.tsx`, and the three test files) produced zero TypeScript errors.

## 5. ESLint

`npx eslint` run against every changed/A2-relevant path (`components/admin/AdminShell.tsx`, `lib/admin/{adminAreas,homeQueues,navigationRegistry}.ts`, `app/(app)/admin/layout.tsx`, `app/(app)/admin/home/page.tsx`, and the three A2 test files). **Exit code 0, zero errors, zero warnings, zero output.**

## 6. Full deterministic repository suite

Not run in full during this pass (the targeted admin-relevant suite above was prioritized given host contention and the time budget for this reconciliation). This is a disclosed gap alongside the live-DEV browser evidence gap — see `A2_14_TERMINAL_CERTIFICATION_REPORT.md` §2 for how it factors into the verdict. Nothing in this branch's diff touches any file outside `app/(app)/admin/**`, `components/admin/**`, `lib/admin/**`, `tests/unit/adminA2*.test.ts`, and `docs/admin/**` — the blast radius for a full-suite regression is structurally limited to those paths (no shared utility, RLS policy, RPC, or non-Admin route was edited), which bounds, without eliminating, the risk of not having run the whole suite.

## 7. Production build

Not run to completion in this pass (see §6 — same contention/time-budget disclosure). Recommended as the first follow-up action before any merge decision.

## 8. Regression invariants re-confirmed by inspection (not re-executed as a separate suite this pass)

- `lib/admin/adminNav.ts` exports (`buildAdminNavGroups`, `shouldShowAdminMenu`, `NO_ADMIN_CAPABILITIES`, the four legacy item lists, `parseAdminCapabilities`/`parseIsAdmin`) are byte-for-byte unedited — confirmed by `git diff` showing zero changes to that file, and directly asserted by `tests/unit/adminA2CanonicalShell.test.ts`'s "pre-existing lib/admin/adminNav.ts contract is untouched" describe block (2 tests, both pass).
- `lib/resources/permissions.ts` is byte-for-byte unedited (`git diff` shows zero changes) — no capability predicate changed.
- The Recommendations Gap withdrawal (`api/admin/recommendations/gaps`) is untouched — no file in that route's path appears in this branch's diff.
