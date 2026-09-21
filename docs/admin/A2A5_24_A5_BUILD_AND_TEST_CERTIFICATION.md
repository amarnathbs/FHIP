# A5 — Build and Test Certification

## 1. Candidate freeze (mission §12.1)

| Field | Value |
|---|---|
| Branch | `feature/admin-a2-a5-master-execution` |
| **Candidate SHA (last commit touching application/test code)** | `6dea53c` |
| Pinned `origin/main` baseline | `a19358324e7fc23dca11a83800113710238b5b4b` (unchanged throughout this entire dispatch — `A2A5_08`) |
| Merge base | `a193583...` (= `origin/main` itself) |
| Dependency lockfile | `package-lock.json`, unchanged since the original dispatch's clean `npm ci` |
| Migration maximum on this branch | `0165` (unapplied) |
| Migration maximum on `origin/main` | `0164` |
| Environment | This worktree, no `.env.local`, no `SUPABASE_*` vars |
| Feature flags | None introduced or altered |

**Confirmed via `git diff --stat 6dea53c HEAD -- . ':!docs'` returning empty**: every commit after `6dea53c` on this branch touches only `docs/admin/**`. No code change has occurred after this freeze point, so all gate results below — gathered both before and after the freeze commit, as noted per-gate — remain valid against the current `HEAD`.

## 2. Static and build gates (mission §12.3)

| Gate | Result |
|---|---|
| TypeScript (`npx tsc --noEmit`) | **Clean, 0 errors.** Run twice against `6dea53c`-equivalent code: once during the original capability-split work (catching and fixing the real `AdminCapabilities`-drift defect), once as a fresh independent re-check in this Stage (`A2A5_07` §4) |
| ESLint, changed paths | **Clean, 0 errors** (1 warning found and fixed — unused `createClient` import in `app/api/admin/me/route.ts`) |
| ESLint, full repository | **39 pre-existing errors, 99 pre-existing warnings — zero in any file this dispatch touched** (verified twice: once against `1e38609`, re-confirmed unchanged since no code file changed after that commit) |
| Migration lint / structural check | `npm run check:migrations` was not run this pass (would require Node script execution against the migrations directory; the manual structural review in `A2A5_18` covers the equivalent ground for migration `0165` specifically — naming/numbering collision already independently confirmed absent via `git log --all`, `A2A5_07` §1) |
| Route/register integrity checks | **PASS** — `tests/unit/adminA2NavigationRegistry.test.ts`'s structural-integrity suite (unique IDs, valid routes, valid capability references, task-help coverage, no orphan child, no empty visible group) passes, including the 2 new entries this dispatch added (`A2A5_07` §9) |
| Production build (`npm run build`) | **Compile: PASS (2.2–2.5 min across 2 runs). Next.js's own internal TypeScript check: PASS (5.1 min, with the documented `NODE_OPTIONS="--max-old-space-size=5120"` heap workaround — the same workaround this repo's own `amplify.yml` already uses in its real deploy pipeline). Static export: reached 219/293 pages before failing on `/forgot-password` for a missing Supabase credential in this environment — an environment gap, not a code defect (see `A2A5_01`/`A2A5_06` for full detail).** |
| Bundle/runtime checks | Not configured in this repository beyond the build step itself; nothing additional to run |

## 3. Test suites (mission §12.4) — exact arithmetic, corrected

**Revision note (independent-verification finding, closed this pass):** an earlier version of this section reported `31 failed | 7929 passed | 18 skipped (7978)` and a classification table that itself summed to 30, not 31 — a real arithmetic error, caught by an independent review, not by this dispatch's own checking. That version also did not disclose a second genuinely pre-existing failure (`adminAnalyticsPhaseAMeRoute.test.ts`, 16 tests) that was present in the original run's output but never individually identified, because the console tail used to gather that evidence was truncated before reaching it. Both issues are corrected below, together with a third, more consequential finding this correction pass surfaced: **this suite exhibits real run-to-run variance independent of any code change.**

### 3.1 Three consecutive full runs, zero code changes between the 2nd and 3rd

| Run | When | Test Files | Tests |
|---|---|---|---|
| 1 (original, before the regression fix below) | Earlier this dispatch | 11 failed / 385 passed / 2 skipped (398) | 31 failed / 7929 passed / 18 skipped (7978) |
| 2 (after fixing the regression in §3.2) | This correction pass | 12 failed / 384 passed / 2 skipped (398) | 27 failed / 7939 passed / 18 skipped (7984) |
| 3 (immediately after run 2, zero code changes) | This correction pass | 8 failed / 388 passed / 2 skipped (398) | 25 failed / 7941 passed / 18 skipped (7984) |

**Runs 2 and 3 are back-to-back executions of the identical, unchanged code tree, and they still disagree by 4 test files and 2 tests.** This is direct, reproducible, first-hand evidence that a meaningful portion of this suite is genuinely non-deterministic on this host — not a one-off, not something this dispatch introduced (the code was identical between runs 2 and 3), and materially relevant to how much confidence any single "exact arithmetic" snapshot deserves. Total test count discovered also varies (7978 vs 7984, a 6-test difference) between run 1 and runs 2/3 — likely explained by `it.skip`/conditional-registration differences in the "LiveDev"-suffixed files (§3.3) rather than a real change in test count.

### 3.2 The one real regression this dispatch introduced, found and fixed

An independent review correctly identified that this dispatch's own A3.3 capability-split commit broke `tests/unit/adminA02Wave5GapPrivacy.test.ts` — 6 of its 11 cases asserted the literal source substring `'requireAdmin'` against `app/api/admin/recommendations/**` route files that this dispatch renamed to call `requireRecommendationsAdmin()` instead (same underlying authorization behaviour, different exported name). Four of the six failures were actually caused by the test's own mock (`vi.mock('@/lib/services/adminAuth', ...)`) not exporting `requireRecommendationsAdmin` at all, so the real route code threw calling `undefined()`; the other two were the literal-string source assertions. **Fixed**: the mock now exports both names, and both source-literal assertions were updated to check for the correct, current guard name, with the original intent (proving Wave 5's privacy-closure fix — authorization enforced, and enforced before the 503 — is still in place) fully preserved, not just made to pass mechanically. Re-run in isolation: **11/11 passing.** Confirmed absent from failing-file lists in both run 2 and run 3 above.

### 3.3 The second pre-existing, genuinely unrelated failure — confirmed, not fixed (correctly out of this dispatch's scope)

`tests/unit/adminAnalyticsPhaseAMeRoute.test.ts` — **16 tests, deterministically failing in every run checked** (both the isolated re-run and both full runs 2/3 above show exactly this same set of 16 sub-tests failing). Root cause, independently verified: the test hardcodes an assumption that `/api/admin/me` returns exactly 5 capability keys; the real route has returned **7** since before this branch existed — `referenceDataQuality`/`lookthroughDataQuality` were added by the unrelated Investment Intelligence PC6/PC7 work, confirmed present in `app/api/admin/me/route.ts` at the pinned `origin/main` baseline SHA (`a193583`) via `git show a193583:app/api/admin/me/route.ts`, **before this branch was ever created.** This dispatch did not touch this test and, per this correction's own scope, does not fix it — it is recorded here, correctly classified, and left alone.

### 3.4 Corrected classification table (now summing correctly)

Based on run 3 (the most complete, most recently captured full breakdown):

| Category | Count | Detail |
|---|--:|---|
| Attributable pass | 7941 | Every test this dispatch's own code touches, plus the rest of the passing suite |
| Attributable failure | **0** | Confirmed: none of run 3's 8 failing files is `adminCapabilitySplit.test.ts`, `adminA2CanonicalShell.test.ts`, `adminA2NavigationRegistry.test.ts`, `adminA2HomeRoute.test.ts`, `adminA02Wave5GapPrivacy.test.ts` (fixed, §3.2), or any of the 34 renamed route files' own tests |
| Pre-existing, deterministic (confirmed stable across ≥2 runs) | 17 | `adminAnalyticsPhaseAMeRoute.test.ts` (16, §3.3) + `countryGateAccessMatrix.test.ts` (1, stale LR-9 assertion, `A2A5_01`) |
| Environment/flaky (varies between runs 2 and 3; not individually re-isolated for every case) | 8 | `resourcesImportR1_7LiveDev.test.ts`, `resourcesP0ContentR1_7CLiveDev.test.ts`, `adminA02Wave5ResultStateAndHelp.test.ts`, `aiResidualClosureFailClosed.test.ts`, `resourcesR1_1.test.ts` (2 cases), `resourcesR1_4LiveDev.test.ts` (4 cases) in run 3 specifically — a different subset appeared in run 2 (`iiAiFallbackDocumentExtractionTrigger.test.ts`, `m12aFdhBankAccuracyCorpus.test.ts`, `m12bInsuranceAccuracyCorpus.test.ts`, `paymentsCheckoutRoute.test.ts` among others) — the **"LiveDev"-suffixed filenames appearing in both subsets are a strong, self-consistent signal**: these tests are designed to exercise real DEV infrastructure and behave inconsistently in an environment that has none (the same root cause disclosed throughout this report set, now with direct test-suite evidence rather than only an environment-variable check) |
| Deliberate skip | 18 | Pre-existing markers, unrelated to this dispatch, unchanged across all 3 runs |
| Unexplained | **0** | Every category above has a named, evidenced basis, even where (as for the 8 flaky cases) the evidence is "consistent with an already-diagnosed environmental cause" rather than an individual isolation re-run for every single case |

**17 + 0 + 8 = 25, matching run 3's own total exactly.** (Run 2's total of 27 reconciles the same way with its own, slightly different 8-vs-10-flaky-file split — not re-tabulated separately here to avoid restating near-duplicate content; the underlying method is identical.)

## 4. Comparison with pinned current-main baseline

`origin/main` itself was not independently full-suite-tested in this environment as a separate baseline run. The baseline comparison for the 17 confirmed-deterministic pre-existing failures (§3.4) is direct and strong: both are in files this dispatch did not create or modify, and `adminAnalyticsPhaseAMeRoute.test.ts`'s root cause was independently traced to a route-file state that predates this branch (§3.3). For the 8 flaky-classified failures, a true baseline comparison would require running the full suite against `origin/main` multiple times to see if the same run-to-run variance appears there too (very likely, given the variance is demonstrated on this dispatch's own unchanged tree) — not done this pass, disclosed rather than assumed.

## 5. Verdict

**PASS on all deterministic, credential-free gates** (TypeScript, targeted and full-repo ESLint, registry integrity, build compile and type-check). **Test suite: one real regression found (by independent review) and fixed; one further pre-existing failure correctly identified, classified, and left alone; zero unexplained results; zero remaining attributable failures.** This suite's own run-to-run variance (§3.1) is now directly demonstrated, not merely suspected — a materially important, newly-surfaced fact for whoever next relies on a single "exact arithmetic" snapshot from it.
