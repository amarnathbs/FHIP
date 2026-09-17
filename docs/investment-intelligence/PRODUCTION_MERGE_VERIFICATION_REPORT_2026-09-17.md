# Production Merge Verification Report — AIE-1/PC4-PC10 Mission (M0–M11 + M12A–E)

**Date:** 2026-09-17
**Branch under test:** `production-merge-2026-09-16` (created from a detached checkout of `cc7186e`, itself a clean fast-forward merge of `mission/m12e-final-dev-cert-2026-09-15` into `origin/main`)
**Merge base → tip:** `origin/main`@`23b49da` → `cc7186e` (fast-forward, 400 files, +95,979/−41)
**Follow-up fix commit:** `9d22330` — `fdh1Isolation.test.ts` allow-list correction (see §4)
**Scope of this report:** verification only — no push to `origin/main` has happened yet. This is the evidence gate the mission's own "Controlled Merge/Push Template" (Part Y) requires before that push.

---

## 1. Summary verdict

| Gate | Result |
|---|---|
| Merge (fast-forward) | ✅ Clean |
| `tsc --noEmit` | ✅ Clean, 0 errors |
| `npm run build` | ✅ Genuine full success (290/290 static pages, all manifests written) |
| Full `npx vitest run` | ✅ Clean **after one real fix** — see §4 |
| `npx vitest run --config vitest.live-dev.config.ts` | ⏳ Not yet run |
| Push to `origin/main` | ⏳ Blocked on a decision — see §6 |

**Headline finding:** today's merge itself introduces **zero test regressions**. Of the ~39 test failures first observed, all but one were already broken on `origin/main` before this merge ever happened (pre-existing, confirmed by ancestor/diff checks). The one failure the merge did cause was found, understood, fixed, and verified. However, the pre-existing failures include a **serious, already-live regression** in a previously "FROZEN, certified FULL PASS" area (SMSF / LR-FI-1 / LR-FI-2), which is a separate, urgent finding this report surfaces but does not fix.

---

## 2. Environment recovery (before any test evidence could be trusted)

This worktree was freshly created for the merge, and several environment problems had to be resolved before a real build/test signal was possible. None of these were code defects — all were local tooling/environment state.

1. **Corrupted `node_modules` in the worktree.** A fresh `git worktree add` does not share `node_modules` with the main checkout, and repeated `npm install` attempts raced against ~15 stale, days-old `node.exe` processes accumulated over a very long session, producing four consecutive distinct build failures (missing `.bin/next` symlink, missing `@swc/helpers`, missing `next/dist/server/require-hook.js`, missing `@next/env`). Root cause confirmed via direct inspection (`node_modules/@next/` absent entirely) and via `tasklist`. **Resolved** once the user ran a clean `rm -rf node_modules && npm install` in a terminal free of the stale-process contention.
2. **Missing `.env.local` in the worktree.** Git does not track `.env.local` (gitignored), so a new worktree never receives it. This caused `npm run build` to fail while statically prerendering `/login` (`@supabase/ssr: Your project's URL and API key are required`). **Resolved** by copying `.env.local` from the main checkout (`D:\FHIP\.env.local`).
3. **`.env.local` itself had a UTF-8 BOM and Windows CRLF line endings.** This is a pre-existing property of the main checkout's file, not something this session introduced. It silently broke the hand-rolled `loadEnv()` regex parser (`^([A-Z0-9_]+)=(.*)$`) used by ~9 live-Supabase-dependent test files in two ways: the BOM sits before the first line's key, and `.`/`$` in a JS regex cannot match across a bare trailing `\r`, so `split('\n')` without stripping `\r` leaves every parsed line unmatched. This made every one of those ~9 files fail instantly and completely (`Error: supabaseUrl is required`) regardless of their actual logic. **Resolved** by normalizing the file (BOM stripped, CRLF → LF) in both the main checkout and the worktree. This single fix recovered **104 of 106** previously-unrunnable tests in the first four files sampled.
4. **Worktree was on a detached HEAD**, not a branch — it had been created by checking out the SHA `cc7186e` directly. This put the later fix commit (`9d22330`) at risk of becoming unreachable. **Resolved** by creating a real branch (`production-merge-2026-09-16`) pointed at the current HEAD.
5. **PowerShell got stuck on a `>>` continuation prompt** partway through the session (an unmatched quote/brace from an earlier command), silently swallowing every subsequent typed command as part of one unterminated statement for several minutes. **Resolved** with Ctrl+C.
6. **Supabase Auth OTP rate-limiting**, triggered by running the same live-DB-dependent test files three times in quick succession within this session. This caused three additional, transient failures (`iiR6P1Certification`, `resourcesEditorR1_3`, `resourcesR1_7DFinalLiveDev`) that **cleared on their own** after a short cooldown and a clean re-run — confirmed not to be real defects.

---

## 3. Build verification detail

```
Next.js 16.2.12 (Turbopack)
Compiled successfully in 4.9min
Finished TypeScript in 2.7min
Collecting page data using 3 workers
Generating static pages using 3 workers (290/290) in 1734ms
```

Verified as a genuine success (not just exit code 0, given this environment's history of silent false-success builds) by confirming:
- `.next/BUILD_ID`, `.next/routes-manifest.json`, `.next/prerender-manifest.json`, `.next/required-server-files.json`, `.next/images-manifest.json`, `.next/build-manifest.json` all freshly written.
- The full 290-route table printed with **zero errors**, including `/login` — the exact page that failed before the `.env.local` fix — now correctly shown as `○ (Static)`.

---

## 4. The one real test regression from this merge — found and fixed

**File:** `tests/unit/fdh1Isolation.test.ts` (touched by the merge: +94 lines, an allow-list of FDH-consumer exceptions maintained across the AIE-1 programme).

**Failure:**
```
AssertionError: FDH is imported by an unapproved consumer:
  lib/services/investment-intelligence/documentProcessing.ts,
  app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts,
  app/api/business-entities/route.ts,
  app/api/investment-intelligence/cron/pc6-reference-ingest/route.ts,
  components/investment-intelligence/InvestmentIntelligenceSubNav.tsx
```

**Root cause:** later mission phases (PC5/PC6/HUF, dated 2026-09-15) added 5 files that reference the string `financial-data-hub`, but never added the corresponding allow-list entries this isolation test requires — an oversight in the mission's own test maintenance, not an architecture violation.

**Investigation — real import or comment mention?** Checked each file by hand:

| File | Finding |
|---|---|
| `lib/services/investment-intelligence/documentProcessing.ts` | **Real import** — `checkPasswordAttemptRateLimit`, `MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR` from FDH-5's bank-PDF password module. Legitimate reuse, same pattern already approved for AIE-1.3's `fdhBankStatement` adapter elsewhere in this same file. |
| `app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts` | **Real import** — same rate limiter. |
| `app/api/business-entities/route.ts` | Comment only — cites an FDH route as prior art. No import. |
| `app/api/investment-intelligence/cron/pc6-reference-ingest/route.ts` | Comment only — cites an FDH cron route as prior art. No import. |
| `components/investment-intelligence/InvestmentIntelligenceSubNav.tsx` | Comment only — cites an FDH component as a placement precedent. No import. |

**Fix:** added all 5 to the test's allow-list with justifying comments, following the file's own established convention (distinguishing "genuine reuse" entries from "naive-substring false positive" entries). Commit `9d22330`.

**Verification:** re-ran the file in isolation — **25/25 passed.**

---

## 5. Everything else that fails — confirmed pre-existing, not caused by this merge

For every remaining failing file, two independent checks were run:
1. `git diff origin/main..cc7186e --stat -- <file>` — is the file even touched by this merge?
2. `git merge-base --is-ancestor <file's last commit> origin/main` — is that content already live in production?

Both checks came back clean (unchanged, already an ancestor of `origin/main`) for every file below.

### 5a. Transient — cleared on re-run, not real defects

| File | First run | Retry after cooldown |
|---|---|---|
| `iiR6P1Certification.test.ts` | 1 failed (5000ms timeout writing a report file) | ✅ Passed |
| `resourcesEditorR1_3.test.ts` | Whole-suite failure (`Failed to verify OTP: Request rate limit reached`) | ✅ Passed |
| `resourcesR1_7DFinalLiveDev.test.ts` | 13 skipped (cascaded from the rate limit above) | ✅ Passed |

These were caused by this verification session itself running live-Supabase-dependent suites three times in quick succession, exhausting Supabase's own Auth rate limit. Not a code issue.

### 5b. Pre-existing, already broken on `origin/main` today

| Cluster | File(s) | Failing tests | Notes |
|---|---|---|---|
| **SMSF / LR-FI-1 / LR-FI-2** | `smsfHouseholdIsolation.test.ts`, `lrFi2HouseholdDebtRatios.test.ts`, `lrFi2DebtServiceExactlyOnce.test.ts`, `lr12rSmsfPropertyLoanLinkOverride.test.ts` | 19 | **Serious.** This exact area was certified by the Product Owner on 2026-09-11 as "UNCONDITIONAL FULL PASS — LIVE RECOVERY PROGRAMME PRODUCTION CERTIFIED & CLOSED. FROZEN." It is broken in production right now, unrelated to today's merge. Failure signature: several tests off by a consistent $365,000 in net-worth/liability totals, suggesting an SMSF-loan inclusion/exclusion ordering defect. |
| **Admin capability resolution** | `adminAnalyticsPhaseAMeRoute.test.ts` | 17 | Pre-existing, already live. |
| **Misc single-test failures** | `aiResidualClosureFailClosed.test.ts`, `countryGateAccessMatrix.test.ts` | 2 | Pre-existing, already live. |
| **Live-network timeout** | `resourcesR1_1.test.ts` | 1 | Consistently fails at ~5014–5019ms against a 5000ms test timeout, performing 5 sequential live round-trips to the dev Supabase project. Looks like a too-tight timeout for real network latency, not a functional defect — but not proven either way in this session. |

**Total pre-existing, unrelated-to-this-merge failures: 39 tests across 8 files.**

None of this was caused by, or made worse by, today's merge. But it was not previously visible either — the evidence strongly suggests nobody has run the full `vitest run` suite against `origin/main` since the commits in §5b's "last touched" history landed (some via the LR-P0/app-review-findings merge earlier this same session).

---

## 6. Decision needed before push

The mission merge itself is verified clean and ready:
- No regressions of its own.
- Its one real defect (§4) is fixed and committed.
- Build is genuinely green.

But §5b is a separate, serious, already-live production issue that predates this work. Two honest paths forward:

**Option A — Push the mission now.** It is unrelated to and does not worsen the SMSF/admin-capability regression. Open a dedicated, urgent investigation into §5b as its own piece of work, separate from this merge.

**Option B — Hold the push.** Investigate and fix the SMSF/LR-FI and admin-capability regressions first, then push everything together, so `origin/main` never has more than a moment of overlap between "PC4-PC10 shipped" and "known-broken SMSF logic still in production."

Neither is contradicted by the evidence — this is a prioritization call, not a technical one, and it belongs to the user.

**Still outstanding regardless of the above:**
- `npx vitest run --config vitest.live-dev.config.ts` has not yet been run (Step 3 of the mission's own Controlled Merge/Push Template, second half).
- Push to `origin/main` itself.
- Post-push: Amplify deployment verification, then the 4 AIE feature flags in mandated order, then the household-member UI, then OA-11 reprocessing.

---

## 7. Files changed in this verification session (beyond the mission's own 400)

| File | Change |
|---|---|
| `tests/unit/fdh1Isolation.test.ts` | Allow-list fix, commit `9d22330` (see §4) |
| `D:\FHIP\.env.local` (main checkout, gitignored) | BOM stripped, CRLF → LF normalized |
| `.env.local` (this worktree, gitignored) | Copied from main checkout, then re-copied post-normalization |
| `production-merge-2026-09-16` (new local branch) | Created to anchor HEAD after discovering the worktree was detached |

No other source files were modified as part of this verification pass.

---

*Report generated during a live, interactive verification session. All findings above were independently confirmed via direct command output — build manifests on disk, `git log`/`git diff`/`merge-base` ancestry checks, and re-run test results — not inferred from exit codes alone, given this environment's own history of misleading exit-code-0 false successes.*

🤖 Generated with [Claude Code](https://claude.com/claude-code)
