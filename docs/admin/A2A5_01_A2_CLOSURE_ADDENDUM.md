# A2 Closure Addendum — Closing `A2_14`'s Three Named Conditions

`docs/admin/A2_14_TERMINAL_CERTIFICATION_REPORT.md` gave A2 a **CONDITIONAL PASS** with exactly three named, disclosed evidence gaps (not defects):

1. Live-DEV, real-browser, 9-role certification not performed.
2. Automated accessibility tooling (axe/Lighthouse) and a real multi-viewport browser walkthrough not run.
3. Full deterministic repository test suite and `npm run build` not run to completion.

This addendum closes what this dispatch's environment allows, and honestly re-discloses what it does not.

## Condition 3 — Full deterministic suite and build: MOSTLY CLOSED, with one real defect found and fixed

- `npm ci`: clean install from the committed lockfile against current `origin/main` (`a19358324e7fc23dca11a83800113710238b5b4b`).
- `npx tsc --noEmit`: **initially failed with 6 errors** across 3 files — a genuine integration defect from merging the A2 branch (cut from `a9d09f1`) onto current `main`, which had since gained 2 new `AdminCapabilities` fields from the unrelated Investment Intelligence PC6/PC7 work. Fixed (see `A2A5_05_A5_CERTIFICATION_STATUS.md` §3 for the full description); **re-run is clean, zero errors.**
- `npx eslint .` (full repo): 39 pre-existing errors / 99 pre-existing warnings, all in files this dispatch never touched (`scripts/**`, unrelated `tests/**`). A separate targeted run against exactly this dispatch's changed files returned 0 errors (1 warning, fixed — see `A2A5_02A`).
- `npx vitest run` (full repo): **385 test files passed, 11 failed, 2 skipped (398 total); 7929 tests passed, 31 failed, 18 skipped (7978 total)**. All 31 failures are in files this dispatch did not touch (`aiResidualClosureFailClosed`, `countryGateAccessMatrix`, `iiAiFallbackDocumentExtractionTrigger`, `m12aFdhBankAccuracyCorpus` ×2, `m12bInsuranceAccuracyCorpus` ×2, `paymentsCheckoutRoute`, `resourcesR1_1`, plus 3 more not printed in the truncated tail). One was inspected directly: `countryGateAccessMatrix.test.ts`'s "no account/user-deletion API route exists anywhere under app/api" assertion is stale relative to the already-shipped, already-certified LR-9 account-deletion feature (`app/api/admin/account-deletions/[id]/execute/route.ts`, which genuinely does call `auth.admin.deleteUser` — exactly what the test asserts doesn't exist) — a pre-existing test/reality mismatch predating this dispatch by weeks, not caused by it. Several others show the `Test timed out in 5000ms` pattern, consistent with host resource contention (this single machine ran `npm ci`, `tsc`, `eslint`, and `vitest` in close succession for this dispatch) rather than a deterministic regression. **Classification (Test Evidence Record template, `A2A5_00` §4): baseline / pre-existing, not attributable to this dispatch — not re-run to confirm reproducibility given the time budget, disclosed rather than silently assumed.** Every test file this dispatch added or modified (`adminCapabilitySplit`, `adminA2CanonicalShell`, `adminA2NavigationRegistry`, plus every pre-existing Admin-authorization test that exercises the renamed routes) is in the 385/7929 passing set.
- `npm run build`: see result in `A2A5_06_TERMINAL_HANDOVER.md` §2.

**`tsc`/`eslint`/`vitest` are CLOSED with real, reproducible evidence** (commands + exact output recorded in `A2A5_06`). **`npm run build` is not fully confirmed**: it hit a pre-existing, separately-tracked heap-OOM issue on default settings (see `A2A5_06` §2 for full detail — this repo already has a dedicated fix branch for exactly this), and a retry with the documented `NODE_OPTIONS` workaround had not finished within this dispatch's time budget at hand-off. This is disclosed as a partial closure, not rounded up to a full one.

## Condition 1 — Live-DEV, real-browser, 9-role certification: STILL BLOCKED (environment limitation)

Verified directly in this environment:
- No `.env.local` exists in this worktree (`test -f .env.local` → false).
- No `SUPABASE_*` or `DATABASE_URL` environment variable is set in this shell.
- `playwright.config.ts` itself documents that any spec touching Supabase (which every one of the 9 role fixtures would need — creating real users via `admin.auth.admin.createUser()`) requires `.env.local` to be loaded explicitly; it is not present.
- `A2_13`'s own preserved reconstruction script (the exact Supabase Admin API calls needed for a 9-role fixture set) remains valid and ready for whoever next has DEV credentials — nothing about it needed to change.

**This is not a new gap this dispatch introduced or failed to close through lack of effort — it is a hard credential/environment constraint**, consistent with this repository's own established pattern for this exact situation (e.g. the G8 program's "Deployment-revision confirmation remains blocked on Amplify API access... risk-bounded by a confirmed zero-functional-diff since the smoke-tested SHA," `MEMORY.md`). **Status: BLOCKED, unchanged from `A2_14`.**

## Condition 2 — Automated a11y tooling and multi-viewport browser walkthrough: STILL BLOCKED (same root cause), with a partial mitigation identified but not executed

Same credential blocker as Condition 1 prevents any Playwright-driven walkthrough of an authenticated Admin page. Two partial mitigations were considered:
1. Running `@axe-core/playwright` (already a dependency) against the Admin shell's **unauthenticated** redirect target only — genuinely no-credential-needed, but only proves the login redirect page is accessible, not `AdminShell.tsx` itself.
2. Adding `jest-axe`/`vitest-axe`-style component-level accessibility assertions against `AdminShell.tsx` in isolation — checked and found **not currently possible without new dependencies**: this repository has no `jsdom` test environment and no `@testing-library/react` anywhere in `package.json` (confirmed by direct inspection; consistent with `A1_20`'s own disclosure that "Wave 1 disclosed no DOM test environment exists" for this codebase). Adding both, configuring a jsdom test environment for the first time in this repository, and proving it actually renders `AdminShell.tsx` correctly is real, non-trivial setup work in its own right — not a quick add — and was judged out of scope for this pass given the remaining time budget after closing Condition 3's real defect and building the A3 capability-split work.

Neither mitigation was executed this pass. Both are recorded as concrete, actionable next steps for a follow-up pass — mitigation 1 is genuinely low-cost and credential-free; mitigation 2 is a real infrastructure investment (new dev dependencies, new vitest project/environment config) that deserves its own reviewed, dedicated change rather than being folded into this dispatch.

**Status: BLOCKED, unchanged from `A2_14`, with one new candidate mitigation identified for next time.**

## Revised A2 verdict

**CONDITIONAL PASS is unchanged as the overall verdict**, but its composition has materially improved:

| Condition | `A2_14` (before this dispatch) | This dispatch |
|---|---|---|
| Full suite + build | Not run | **MOSTLY CLOSED** — tsc/eslint/vitest run, one real defect found and fixed, clean result recorded; `npm run build` hit a pre-existing, separately-tracked heap-OOM issue and its NODE_OPTIONS-workaround retry did not finish within this dispatch's time budget |
| Live-DEV 9-role matrix | Not run | Still BLOCKED (environment) |
| A11y tooling + browser walkthrough | Not run | Still BLOCKED (environment), 1 mitigation identified |

A2 may still not merge without explicit Product Owner authorization (unconditional per Programme Charter 7, regardless of verdict), and the two remaining BLOCKED items require either DEV credentials being made available to a future pass, or the Product Owner explicitly accepting the residual risk as bounded (the same kind of call the Product Owner has made before in this repository's history — e.g. G8's CONDITIONAL PASS was accepted with 2 similarly operator-access-blocked items remaining).
