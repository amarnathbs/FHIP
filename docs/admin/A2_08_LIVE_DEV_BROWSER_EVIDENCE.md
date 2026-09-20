# A2 — Live DEV Browser Evidence

## Status: NOT PERFORMED THIS PASS — disclosed evidence gap

No live, real-browser, authenticated-role certification against DEV (dispatch §25) was carried out in this reconciliation-and-implementation pass, for the reasons recorded in full in `A2_10_DATA_RECONCILIATION_REPORT.md` §2 (host-level resource contention observed during this session; an unrelated task's dev server already occupying the shared preview port; the dispatch's own instruction to disclose an evidence gap honestly rather than produce a rushed or partial live run, or substitute client-side simulation for live proof).

## What was verified instead (non-live)

- `git fetch origin` confirms `origin/main` is exactly `a9d09f1` (the A1 merge commit) — no overlapping Admin redesign has landed since A1, and A1 is genuinely present on `origin/main` (dispatch's precondition, §2, verified rather than assumed).
- The full persona matrix (9 rows: role-less, Analyst, Author, Editor, Compliance Reviewer, Publisher, Resource Admin, Super Admin, mixed Analyst+Resource Admin) is exercised by hermetic unit tests against the real decision function (`buildAdminAreas()`), not a hand-simulated approximation of it — see `tests/unit/adminA2CanonicalShell.test.ts`.
- `/admin/home`'s direct-route enforcement (logged-out → `/login`; role-less authenticated → `/dashboard`; Analyst and Super Admin → permitted) is exercised against the actual page component with a mocked Supabase client and a mocked `redirect()` that throws a detectable signal — proving the real code path's branching, not a restatement of the requirement (`tests/unit/adminA2HomeRoute.test.ts`).

These are legitimate, valuable evidence for the underlying authorization and navigation-construction logic, but they are **not** a substitute for dispatch §25's required live walkthrough (sign in as each role, open `/admin`, record visible navigation, follow every destination, confirm breadcrumbs/active-state, open contextual help, attempt a forbidden direct route, test mobile navigation, sign out and verify cleanup) — none of that sequence was executed against a real, rendered, authenticated browser session in DEV.

## What a follow-up live pass needs

1. A dev server for **this worktree specifically** (not the unrelated `lr1-purge-sweep-dev` server already observed running on the shared port from another task) — start with `.claude/launch.json`'s `fhip-dev` configuration on a free port, or coordinate with whichever other session currently holds port 3000.
2. Confirmed low contention on the shared execution host, so a live auth/navigation walkthrough does not itself become an unreliable measurement.
3. Synthetic DEV fixtures for at least: Super Admin, Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Analyst, a role-less authenticated user, and an anonymous session. The creation/teardown logic for the first three already existed as `_tmp_a2_verify_users.mjs` in this branch's working tree before this pass (not committed, deleted per its own instruction) — its exact Supabase Admin API calls are reproduced in `A2_13_A2_TO_A3_HANDOVER_AND_DEFERRAL_REGISTER.md` §3 so it does not need to be re-derived from scratch.
4. Re-query after teardown to reconcile before/after counts, per dispatch §26.

This gap is the primary named condition of the CONDITIONAL PASS verdict recorded in `A2_14_TERMINAL_CERTIFICATION_REPORT.md`.
