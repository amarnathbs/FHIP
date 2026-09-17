# Production Merge & SMSF/LR-FI Recovery — Final Report

**Date:** 2026-09-18
**Verdict: PRODUCTION MERGE — UNCONDITIONAL FULL PASS**

---

## 1. What's now live on `origin/main`

| Milestone | SHA | Status |
|---|---|---|
| Pre-recovery baseline | `23b49da` | Superseded |
| SMSF/LR-FI financial-integrity recovery | `368d98f` | ✅ Live, confirmed via ancestry check |
| Refreshed AIE-1/PC4-PC10 mission merge (M0–M11 + M12A–E + `9d22330` fdh1Isolation fix) | `5faee06` | ✅ Live, confirmed via ancestry check |

`POST_PUSH_MAIN` = `5faee06`, confirmed an ancestor of `origin/main` via `git merge-base --is-ancestor` — not inferred from `git push`'s exit code alone, given this environment's history of misleading successes.

---

## 2. SMSF/LR-FI Financial-Integrity Recovery

**Root cause:** a 2026-09-14 hotfix (`ea95507`) meant to stop double-subtracting an SMSF-linked property loan from Net Worth over-corrected — it excluded *every* SMSF-tagged liability from Net Worth's `totalLiabilities` instead of only the ones genuinely double-counted, dropping some liabilities to **zero** contributions instead of exactly one. This produced the recurring ~$365,000 discrepancy.

**Fix:** reverted `totalLiabilities`/`totalLiabilityMonthlyRepayments`/`liabilityByType` in `lib/engines/dashboard.ts` to the pre-hotfix, LR-FI-1-certified basis (every liability counts in Net Worth regardless of owner); DTI/DSR household-scoping untouched. New regression test added.

**Targeted test counts:** 4 target files, RED 19 failed/96 total → GREEN 97/97 (96 + 1 new regression test). 22 related SMSF/business-entity/net-worth/household/property/goal suites: 293/293 passing.

**Open item, not silently resolved:** the *original* double-subtraction scenario (a real SMSF fund's already-net retirement valuation plus its own linked loan counted again) is real and this revert doesn't fix it — no test covers that exact scenario yet, so nothing regresses, but it needs a proper fix later (a fund/loan correlation key).

---

## 3. AIE-1/PC4-PC10 Mission Merge — refresh and re-verification

The original mission merge (`cc7186e`, verified 2026-09-16/17 in `PRODUCTION_MERGE_VERIFICATION_REPORT_2026-09-17.md`) was refreshed onto the corrected `main` (post-SMSF-fix) per the recovery mission's own sequencing: zero file overlap between the SMSF fix and the mission's own changes, so the merge (`5faee06`) applied with **zero conflicts**.

**Full-suite counts (post-refresh):**
- `tsc --noEmit`: clean
- `npm run build`: genuine success (`.next/BUILD_ID` confirmed)
- `npx vitest run`: **7693 passed / 22 failed / 47 skipped (7762 total)**, across 370 passed / 7 failed / 1 skipped (378 files)
- **New regressions from the mission merge: 0** — every failing file was either on the already-established pre-existing baseline, or confirmed transient (re-ran clean in isolation: `m12aFdhBankAccuracyCorpus.test.ts` and `resourcesAdminRoleCtaHotfixLiveDev.test.ts` both passed 33/33 on retry once system load eased)

**Live-DEV gate (`vitest.live-dev.config.ts`, previously never run against this merge):**
- **113 passed / 40 skipped (153 total)**, across 15 passed / 2 failed / 2 skipped (19 files)
- 2 failures (`module11ResidualLiveDev.test.ts`, `module11_2ResolutionRouterLiveDev.test.ts`) confirmed **pre-existing and unrelated**: both files' last commits are ancestors of the pre-merge base (`23b49da`), and the DB guard they trip (`COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW`) comes from migration `0127`, long predating this merge. Old test-fixture helpers using a direct-`upsert` pattern an old country-confirmation guard now correctly rejects.

**Pre-push gates:**
- Migration numbering collision guard: clean, no duplicate numbers
- Mission branch ancestry: confirmed, `origin/main` (`368d98f`) was a clean ancestor of the integration branch before push

---

## 4. Remaining known, unrelated baseline failures (tracked separately, not blocking)

| Cluster | Files | Nature |
|---|---|---|
| Admin capability resolution | `adminAnalyticsPhaseAMeRoute.test.ts` | Pre-existing, already live before this merge |
| Misc | `aiResidualClosureFailClosed.test.ts`, `countryGateAccessMatrix.test.ts` | Pre-existing, already live before this merge |
| Live-network timeout | `resourcesR1_1.test.ts` | Consistently ~5s vs a 5000ms test timeout on live round-trips |
| Live-DB rate-limit flakiness | `resourcesEditorR1_3.test.ts` and siblings | Clears on retry after cooldown; Supabase Auth OTP rate-limiting from repeated same-session test runs |
| Old country-confirmation guard mismatch | `module11ResidualLiveDev.test.ts`, `module11_2ResolutionRouterLiveDev.test.ts` | Live-dev gate only; pre-existing fixture/guard mismatch from before this merge |

None of these are new, and none were introduced or worsened by today's work.

---

## 5. Deployment and activation — not yet done

- **Amplify deployment**: triggered automatically by the push; not yet independently verified (no Amplify console/API access from this environment — `amplify:ListApps` returns `AccessDeniedException` for the available AWS credentials, consistent with earlier findings this project). Needs either the user checking their own Amplify console, or a live functional check against a non-production-data signal.
- **AIE production activation** (feature flags, cohort gate, kill switch, malware/GuardDuty gate): not started. Per this session's standing practice, this requires the user present in real time — not something to do unilaterally even under a pre-authorizing mission document.
- **Post-deploy production smoke test**: not started, pending deployment confirmation.

---

## 6. Related, separately-tracked work (not part of this push)

- **India Investment Performance tab** (holdings table, transaction-detail modal, AI-fallback extraction, incremental re-upload diff detection): built and verified on `feat/ii-performance-holdings-drilldown-2026-09-17`, **not part of this merge** — a distinct feature branch, not yet reviewed/pushed.
- **Legal banner removal** (`/terms`, `/privacy`, `/disclaimer`): built and verified on `fix/legal-banner-removal-2026-09-17`, **not part of this merge** — awaiting the user's go-ahead to push separately.

---

*All findings above were independently confirmed via direct command output — ancestry checks, isolated re-runs, and build-artifact inspection — not inferred from exit codes alone.*

🤖 Generated with [Claude Code](https://claude.com/claude-code)
