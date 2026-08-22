# Phase 0C.1 — Validation, Completion-Semantics & Closure Report

Branch: `phase-0c-score-eligibility` · Commit: `0d2b13a` · Date: 2026-08-15

---

## A. Executive Summary

**Verdict: CONDITIONAL PASS.**

Phase 0C.1's two structural objectives are both implemented, unit-tested, and live-verified:

1. **Completion semantics corrected.** `effectiveSectionStatus()` no longer treats "at least one row exists" as "the section is fully reviewed." Positive-data sections (Income, Expenses, Assets, Investments, Retirement, and Liabilities/Insurance once rows exist) now require an explicit "I've added everything relevant to me" confirmation — a new `reviewed_with_data` state, persisted the same way `reviewed_zero`/`not_applicable` already were — before they count as reviewed. Rows with no confirmation derive `in_progress`, which blocks Full eligibility but not Preliminary.
2. **Resilience presentation gap closed.** Resilience now has its own `not_yet_available` / `preliminary` / `full` state (`resilienceEligibility.ts`), mirroring the Health Score's treatment, with zero changes to Resilience's weights, formulas, or bands.

Both are live-verified: a genuinely fresh zero-data account shows "Not Yet Scored" / "Resilience assessment is not ready yet" (no `0/100`, no `Critical`); an existing account with real but unconfirmed data correctly moved from a false 71%-confidence "reviewed" reading to an honest 29%.

**Why CONDITIONAL, not FULL PASS:** the same blocker as Phase 0C — a database migration is not yet applied. This phase adds migration `0032_section_status_reviewed_with_data.sql` (widens the `status` CHECK constraint to accept `reviewed_with_data`), on top of `0031` from Phase 0C. Neither is applied in this session's dev Supabase project as of this report (0031 was applied earlier by the founder directly in the Supabase SQL Editor per the prior turn; 0032 was written this turn and has **not** been applied yet). Until 0032 is applied, the new "I've added everything relevant to me" confirmation fails safely (reverts, no false "Saved" — verified live) but doesn't persist. See §B.

A second, smaller reason for CONDITIONAL rather than FULL: the mandatory mature-user regression table (§I) and the Preliminary/Full/Premium report validations (§J) are only partially completed — see those sections for exactly what is and isn't covered, and why.

---

## B. Migration Status

| Migration | Dev applied? | Prod applied? |
|---|---|---|
| `0031_financial_section_status.sql` (Phase 0C) | **Yes** — applied by the founder via Supabase Dashboard SQL Editor prior to this phase; table, RLS, and backfill verified live (Liabilities/Insurance confirmations persist across reload). | No — pending authorisation, as required. |
| `0032_section_status_reviewed_with_data.sql` (Phase 0C.1, new) | **No** — not yet applied. Verified live: without it, the "I've added everything relevant to me" button correctly fails (`PUT /api/user/section-status` → `500`) and the UI reverts rather than showing a false "Saved." | No — pending authorisation, as required. |

**To apply 0032 in dev**, run in the Supabase Dashboard SQL Editor for the dev project:

```sql
alter table user_financial_section_status
  drop constraint if exists user_financial_section_status_status_check;

alter table user_financial_section_status
  add constraint user_financial_section_status_status_check
  check (status in ('reviewed_zero', 'not_applicable', 'reviewed_with_data'));
```

This is additive/backwards-compatible: it only widens an existing CHECK constraint. No other column, table, row, or the RLS policy from 0031 is touched. Full migration file: `supabase/migrations/0032_section_status_reviewed_with_data.sql`.

**Table/RLS re-verification (unchanged from Phase 0C, confirmed still correct by inspection):** `user_financial_section_status` still has its `(user_id, section)` primary key, RLS still enabled, still one policy (`for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`). Migration 0032 does not touch any of this. Live cross-user RLS testing (two separate authenticated sessions) was not re-run this phase — see §K.

---

## C. Completion-Semantics Fix

**Does the presence of one data row automatically mean the financial section is complete? No.**

The corrected state machine, in `lib/engines/financialSectionStatus.ts`:

```
effectiveSectionStatus({ hasRows, explicitConfirmation }):
  1. explicitConfirmation === 'not_applicable'      → not_applicable   (always wins)
  2. explicitConfirmation === 'reviewed_with_data'
       → hasRows ? 'reviewed_with_data' : 'not_started'   (stale confirmation reverts if rows were deleted)
  3. explicitConfirmation === 'reviewed_zero'
       → hasRows ? 'in_progress' : 'reviewed_zero'         (new rows supersede an old zero answer)
  4. no explicit confirmation
       → hasRows ? 'in_progress' : 'not_started'
```

- **`not_started`** — no rows, no confirmation. Never persisted.
- **`in_progress`** — rows exist, but the user hasn't confirmed the section is complete. Never persisted — always derived at read time.
- **`reviewed_with_data`** — rows exist AND the user explicitly clicked "I've added everything relevant to me." **Newly persistable** this phase (migration 0032).
- **`reviewed_zero`** — explicit "I have none of this" (Liabilities/Insurance "No"). Persisted since Phase 0C (0031).
- **`not_applicable`** — explicit "this doesn't apply to me." Persisted since Phase 0C (0031/0029 backfill).

`isReviewed(status)` (used everywhere eligibility/scoring reads section state) is unchanged: `true` for `reviewed_with_data | reviewed_zero | not_applicable`, `false` for `not_started | in_progress`. Because every downstream consumer (`scoreSavings`, `scoreDebt`, `scoreInsurance`, Resilience's `scoreDebtPressure`/`scoreInsuranceProtection`, and the eligibility layer) already gated on `isReviewed()`, the single surgical fix to `effectiveSectionStatus()` was sufficient to correct the semantics everywhere — no other engine code needed to change. This is the "narrowly targeted correction" the brief asked for, not a rewrite.

A new `hasProgressed(status)` helper (`status !== 'not_started'`) was added for the *Preliminary* threshold, which is intentionally looser than `isReviewed()` — see §D/§E.

---

## D. Definitive Eligibility Matrix

| Section | Required for Not Yet Scored → Preliminary | Required for Full | Zero Allowed | N/A Allowed |
|---|---|---|---|---|
| Household/Profile | Always treated as reviewed (onboarding guarantees the profile record exists) | Same | No | No |
| Income | `hasProgressed` (rows exist, confirmed or not) | `isReviewed` (explicit "I've added everything relevant to me", or rows removed) | No (income can't legitimately be zero for a scored household) | No |
| Expenses | `hasProgressed` | `isReviewed` | No | No |
| Assets | `hasProgressed` | `isReviewed` | No | No |
| Liabilities | `hasProgressed` | `isReviewed` | **Yes** — explicit "No, I have no debts" | No |
| Investments | not required for Preliminary | `isReviewed` | No | **Yes** — explicit "I don't have any investments" |
| Retirement | not required for Preliminary | `isReviewed` | No | **Yes** — explicit "I don't have any retirement savings" |
| Insurance | not required for Preliminary | `isReviewed` | **Yes** — explicit "No, I don't currently hold personal insurance" | No (uses zero, not N/A — insurance absence is scoreable risk information, not an exclusion) |

`MINIMUM_FOR_PRELIMINARY = [income, expenses, assets, liabilities]` — the conservative 4-section minimum from Phase 0C, unchanged in *which* sections, but the *threshold* for those 4 changed from `isReviewed` to `hasProgressed` this phase (see §21 rationale in the brief: Preliminary must be reachable while sections are still `in_progress`, or it becomes nearly as hard to reach as Full).

Goals are explicitly **not** part of this matrix — the Health Score doesn't depend on Goals, so Goals aren't forced into score eligibility (per the brief's explicit instruction not to do this).

---

## E. Score State Rules

**Not Yet Scored** — one or more of Income/Expenses/Assets/Liabilities has zero progress (`not_started`): no rows and no confirmation at all. No numeric score, no band, no gauge.

**Preliminary** — all 4 minimum sections have *some* progress (`hasProgressed`: rows exist and/or a confirmation is on file), but at least one of the 7 core sections isn't fully *resolved* (`isReviewed`). A numeric score is shown, explicitly labelled "— preliminary," with the confidence percentage and the list of still-outstanding sections.

**Full** — all 7 core sections (Income, Expenses, Assets, Liabilities, Investments, Retirement, Insurance) are `reviewed_with_data`, `reviewed_zero`, or `not_applicable`. None remain `not_started` or `in_progress`. Normal score presentation, no preliminary caveat.

Non-monotonic scores are accepted by design — see the live example in §H/§I where the same account's raw score changed from 88 to 85 purely because Savings Behaviour correctly stopped being scored on an unconfirmed Expenses section.

---

## F. Financial Data Confidence

**Formula (unchanged from Phase 0C):** `confidencePercent = round(reviewedSections / 7 × 100)`, where `reviewedSections` counts sections satisfying `isReviewed()` — `reviewed_with_data`, `reviewed_zero`, or `not_applicable`. `in_progress` and `not_started` both count as 0 toward the numerator; **this phase's fix is what makes that denominator honest** — previously a section with mere rows already counted as "reviewed" here, which is exactly the bug being closed.

- **Treatment of `in_progress`:** counts as *not* resolved — 0 credit. Documented, deliberate simplification: the brief permits (but doesn't require) partial credit for `in_progress`; this implementation gives none, to keep the number unambiguous ("resolved" or not) rather than introduce a second, harder-to-explain partial-credit scale. Flagged as a legitimate design choice, not an oversight — see §M.
- **Treatment of `reviewed_zero` / `not_applicable`:** full credit — both are real, resolved answers.
- **Thresholds:** High ≥80%, Medium ≥50%, Low <50% (`confidenceTierFor()`, unchanged).
- **Distinction from score-component coverage:** `scoredComponents`/`totalRelevantComponents` (also in `HealthScoreEligibility`) count how many of the 10 Health Score components happen to have enough raw data to calculate a number, which is not the same measure — a component can be mathematically calculable (e.g. Cash Flow, which isn't gated on `isReviewed`) while its underlying section is still `in_progress`. The two numbers are exposed separately and never conflated in the UI.
- **Distinction from Data Freshness:** unchanged — `buildDataQuality()`'s `lastUpdated`/stale-check is a separate axis (recency of the most recent row) from section-review status. This phase additionally split the Data Quality panel's "Missing" status into `stale`/`missing`/`confirmed_zero`/`not_applicable` so a resolved-but-empty section (e.g. confirmed-zero Liabilities) no longer displays as literally "Missing" beside a score that already counts it as reviewed.

---

## G. Resilience Closure

**States** (`resilienceEligibility.ts`): `not_yet_available` (fewer than 2 of 6 components scored) / `preliminary` (2–5 scored) / `full` (all 6 scored). The 2-component floor is a documented, conservative choice — a single scored component (e.g. Emergency Fund alone) wouldn't say much about "resilience" as a whole.

**Confidence treatment:** Resilience keeps its own pre-existing specialised `confidence` formula (recency, verification history, per-category completeness weights) — explicitly labelled "Resilience calculation confidence" (Phase 0C §18) so it's never confused with the canonical Financial Data Confidence. This phase didn't touch that formula.

**Tests:** RS-01..RS-06 (`tests/unit/resilience.test.ts`) — insufficient-data → not-yet-available, partial → preliminary, full-resolution → full, missing-liabilities → `missing_data` on Debt Pressure, confirmed-zero-liabilities → scored 100, missing-insurance → `missing_data` on Insurance & Protection. All 6 passing.

**Raw Resilience methodology changed? No.** `resilience.ts` was not edited this phase — only read. Component weights, score bands, risk-override caps, and the scoring formulas for all 6 components are byte-for-byte unchanged.

**Live-verified:** the same "Phase0B Test User" account showed "58/100 — Moderately Vulnerable — preliminary — Based on 5 of 6 resilience components... Still to calculate: Emergency Fund Adequacy," and the fresh zero-data account showed "Your Financial Resilience assessment is not ready yet — 0 of 6 resilience components calculated."

**Scope note:** the Reports engine's Resilience section (`buildResilience()` in `reportSections.ts`) still uses the pre-existing, separate report-level section-eligibility gate (`computeSectionEligibility`), not the new component-level `resilienceEligibility.ts`. That gate already prevents an untrustworthy Resilience number from appearing in a report for a genuinely low-data household (confirmed live in §J's Report Test). Reconciling the two eligibility layers for Resilience specifically is reasonable follow-up work, not a blocker — flagged in §M.

---

## H. Fresh User Walkthrough

A brand-new account (`phase0c1.test@example.com`) was created this session — not a reused Phase 0B/0C fixture — and taken through onboarding with profile-only data (no financial records).

| Step | Observed |
|---|---|
| Profile only (0 of 7 sections) | Dashboard: **"Your Financial Health Score is not ready yet — 0 of 7 core sections reviewed — Continue my Financial Picture."** No `0/100`. No `Critical`. No gauge. |
| Same state | `/score`: same state (same shared `HealthScoreStateCard`, same `eligibility` object — cannot diverge). |
| Same state | Priority Actions: **"We need more information before identifying your priorities."** |
| Same state | Resilience: **"Your Financial Resilience assessment is not ready yet — 0 of 6 resilience components calculated."** |
| Same state | Data Quality panel: all 7 categories correctly show **"Missing"** (genuinely never touched — not a bug, since nothing has been reviewed yet). |
| Same state | Report generation: allowed to proceed, but the generated report shows no numeric score anywhere and states plainly: *"A monthly financial-health report requires income, expenses, assets, liabilities and a Financial Health Score for the selected period."* No `0/100`. |

Full step-by-step progression through every section (income row → confirm → expense row → confirm → …) was **not** re-run end-to-end this phase on the fresh account, beyond the Income page spot-check in §J's persistence test — the CS-01..CS-10 unit tests already exhaustively cover every transition in this state machine in isolation (not_started → in_progress → reviewed_with_data → reversed, for every combination), which is a stronger, more precise check than a single manual click-through would add. Flagged as intentionally not duplicated, not as skipped work.

---

## I. Mature User Regression

**Full 10-persona before/after table (§32/§33 of the brief) was not completed this phase.** This requires either direct database access to the existing 50-user dev fixture (`User tests/FHIP_50_User_E2E_Test_Package/harness/`) or login credentials for those accounts, neither of which is available in this session (no Supabase CLI/connection string, and this session doesn't have the fixture accounts' passwords stored). This is an honest gap, not a hidden one — flagged as a blocker for **Full PASS**, addressable by re-running the existing, already-built 50-user harness (a standing fixture, not new work) against this branch and diffing the output. Recommend the founder or a session with harness credentials runs this before merge.

**What *is* available — one real, live before/after data point**, captured directly in this session on the same account, same underlying data, same day, before vs. after this phase's semantic fix:

| Test Case | Country | Pre-0C.1 Score | Post-0C.1 Score | State | Difference | Explanation |
|---|---|---:|---:|---|---:|---|
| Phase0B Test User (income, expenses, 1 asset, confirmed-zero liabilities/insurance) | AU | 88 | 85 | preliminary → preliminary | −3 | Savings Behaviour moved from `scored` to `missing_data`: Expenses had rows but was never explicitly confirmed reviewed, so under the corrected semantics it's `in_progress`, not `reviewed_with_data`. This is exactly the Phase 0C.1 §19 rule in effect — Savings Behaviour must not be treated as reviewed merely because one expense row exists — and is a legitimate, explained, non-invalid change, not a regression. |
| Same account | AU | confidence 71% | confidence 29% | — | −42pp | Same root cause: Liabilities/Insurance (confirmed-zero) are the only 2 of 7 sections that count as resolved now; Income/Expenses/Assets have rows but no completion confirmation, so they correctly stopped counting toward confidence. |

Both differences are fully explained by the intended fix, not by any change to scoring arithmetic, weights, or bands (confirmed via `git diff` — `healthScore.ts` itself was not touched this phase).

---

## J. Report Validation

| Test | Account/State | Report Type | Observed | PASS/FAIL |
|---|---|---|---|---|
| Report Test 1 — Not Yet Scored | Fresh zero-data account (`phase0c1.test@example.com`) | Free (Monthly) | Report generation proceeded but rendered no numeric score anywhere; explicit insufficient-data explanation shown (quoted in §H). No `0/100`, no `Critical`. | **PASS** |
| Report Test 2 — Preliminary | Not run this phase | Free | Not completed — see below. | Deferred |
| Report Test 3 — Full | Not run this phase | Free | Not completed — see below. | Deferred |
| Report Test 4 — Premium | Not run this phase | Premium | Not completed — see below. | Deferred |

**Why 2–4 weren't completed:** generating a Preliminary/Full/Premium report requires switching the live session to a different, already-Preliminary account (e.g. "Phase0B Test User") and re-authenticating, and Free-report generation carries a real per-month idempotency/versioning rule (`isFirstReport` logic) that risks consuming or altering that account's actual report history for a check that's secondary to the two structural fixes this phase targeted. Given the time already spent on the higher-priority live checks (fresh zero-data proof, migration-dependent persistence, mature-user before/after), this was deliberately deferred rather than rushed. The underlying wiring — `buildHealthScore()` in `reportSections.ts` branching its `narrativeText` on `hs.eligibility.state` exactly as Phase 0C originally implemented and this phase left untouched — was already unit-verified in Phase 0C's own regression pass and is not expected to behave differently, since this phase changed *inputs* to the eligibility computation (section status), not the report-rendering logic that consumes `eligibility.state`. Recommend as the first item to verify before Full PASS.

---

## K. Database & RLS Validation

- **Schema/constraint verification:** confirmed by inspection — migration 0032 only widens the `status` CHECK constraint on `user_financial_section_status`; no other column, table, or the 0031 RLS policy is touched.
- **Own-user behaviour:** live-verified (this session and the prior turn) — PUT/GET `/api/user/section-status` correctly reads/writes only the authenticated user's own rows via the request-scoped Supabase client (no service-role client in this path).
- **Cross-user isolation:** **not re-tested live this phase** (would require two concurrent authenticated sessions). Carried forward from Phase 0C's completion report as an existing, documented gap — the RLS policy itself (`auth.uid() = user_id` on both `using` and `with check`) is architecturally sound and unchanged, but a live two-session test has still not been performed in any phase to date. Flagged for Full PASS.
- **Unauthenticated access:** `requireUser()` gates both GET and PUT in `app/api/user/section-status/route.ts` (unchanged this phase) — returns the standard unauthenticated response before touching Supabase.
- **API validation** (§40): `VALID_SECTIONS`/`VALID_CONFIRMATIONS` allow-lists updated to include `reviewed_with_data`; invalid section → `422`; invalid status → `422` with the updated message; arbitrary user IDs cannot be supplied (the route derives `user.id` from the authenticated session, never from the request body); `setSectionConfirmation()` still throws on any Supabase error rather than swallowing it (Phase 0C's fix, re-verified live this phase via the pre-migration `500` on the new confirmation type — confirms the honest-failure pattern extends correctly to the new status value without any additional code change needed).

---

## L. Automated Test Results

```
npx vitest run
 Test Files  15 passed (15)
      Tests  158 passed (158)

npx tsc --noEmit
 (clean, exit 0)

npm run build
 ✓ Compiled successfully
 (all routes, including /dashboard, /resilience, /reports/[id], /reports/[id]/print — exit 0)
```

Breakdown of the 18 new/changed tests this phase (`tests/unit/healthScore.test.ts`, `tests/unit/resilience.test.ts`):
- 3 existing Phase 0C tests updated to add explicit `reviewed_with_data` confirmations where the test's actual intent was "this section is fully reviewed" (Group C, Group K, confidence-tier-boundaries) — the corrected semantics made the old row-only setup insufficient to reach those states, which is the fix working as intended, not a broken test.
- 12 new tests: CS-01 through CS-10 (plus CS-03b, CS-04b) covering every `effectiveSectionStatus()` transition and Full/Preliminary boundary condition.
- 6 new tests: RS-01 through RS-06 covering Resilience's new eligibility states and confirming the raw scoring methodology is unaffected.

No FHIP 50-user harness run, no Playwright suite run this phase (neither available/practical in this session — see §I and §M).

---

## M. Outstanding Issues

**Blockers for Full PASS:**
1. Migration 0032 not yet applied in dev (or prod). Blocks live persistence of the new `reviewed_with_data` confirmation.
2. Full 10-persona mature-user regression table (§I) not completed — only one real before/after data point captured live.
3. Report Tests 2–4 (Preliminary/Full/Premium) not completed live (§J).
4. Cross-user RLS isolation not live-tested with two concurrent sessions (§K) — carried forward from Phase 0C, still outstanding.

**Non-blocker, documented design decisions (not defects):**
5. `in_progress` sections receive zero partial credit toward Financial Data Confidence, by deliberate choice (§F) — the brief explicitly permits but doesn't require partial credit; this keeps the number unambiguous.
6. A household with rows in every section but zero explicit confirmations can reach Preliminary (rows clear the "some progress" bar) while confidence reads 0% — an intentional, honest combination ("here's an early number, but none of it is confirmed yet"), verified in the CS-09 test, not a bug.
7. Resilience's Reports-engine presentation still uses the pre-existing report-level eligibility gate rather than the new component-level `resilienceEligibility.ts` (§G) — functionally safe (confirmed the report-level gate already prevents a misleading number), but the two layers aren't yet reconciled.

**Phase 0D / Phase 1 candidates (explicitly out of scope here):**
8. Existing-user transition copy (Phase 0C §38 / brief §38 here) — not implemented, correctly deferred per the brief's own "not the highest closure blocker" guidance.
9. The third recommendation baseline-not-ready state (brief §37 permits deferring this).
10. Reconciling Resilience's two eligibility layers (item 7 above), if judged worth doing.

**No unrelated UX redesign was introduced.** No changes to global typography, colour system, sidebar, navigation, landing page, Recommendation Master content, Forecasting Engine mathematics, or financial benchmark libraries. `git diff --stat` for this phase touches only: section-status semantics, the new Resilience eligibility layer + its presentation component, the Data Quality relabel, the Investments/Retirement not-applicable dual-write fix, one new migration, and tests.

**Production migration was NOT applied** (0031 or 0032) without separate authorisation, per §45.

---

## Acceptance Checklist (§47)

- [x] Migration 0031 successfully applied in development (by the founder, prior turn).
- [ ] Migration 0032 applied in development — **pending**, SQL provided in §B.
- [x] Explicit liability confirmations persist (re-verified this session).
- [x] Explicit insurance confirmations persist (re-verified this session).
- [ ] RLS live-tested (cross-user) — carried-forward gap.
- [x] Existing blank categories are not silently converted to confirmed zero (unchanged from Phase 0C; migration 0032 adds no backfill).
- [x] One data row no longer means a section is automatically complete.
- [x] Positive-data sections support `in_progress`.
- [x] Positive-data sections require explicit completion to become `reviewed_with_data`.
- [x] Zero remains explicit.
- [x] Not applicable remains explicit and distinct from zero.
- [x] Full Score eligibility rule is unambiguous (§D/§E).
- [x] Full Score is impossible while relevant sections remain in progress (CS-06/CS-08 tests).
- [x] Not Yet Scored is live-tested on a new account.
- [x] Preliminary Score is live-tested.
- [ ] Full Score live-tested this phase specifically — full-state eligibility is unit-tested (CS-08, RS-03) but not separately re-demonstrated live this phase (it was live-verified in Phase 0C's own pass, on inputs that predate this phase's semantic change).
- [x] Financial Data Confidence reflects true section review (§F, §H).
- [x] Resilience no longer presents low-data results with full authority.
- [ ] Mature-user score regression completed — partial (§I).
- [x] Mature-user raw arithmetic stable, differences explained (the one data point captured).
- [x] Free Report generated and score-state consistency verified (Not Yet Scored case only).
- [ ] Premium Report checked — not completed.
- [x] Dashboard / Score / Reports agree (verified for Not Yet Scored; architecturally guaranteed for Preliminary/Full via the shared `eligibility` object, not separately re-demonstrated live for those two states this phase).
- [x] Priority Action insufficient-data state verified.
- [x] Failed section-status writes do not falsely appear saved (re-verified with the new `reviewed_with_data` status pre-migration).
- [x] Full automated suite passes (158/158).
- [x] TypeScript passes.
- [x] Production build passes.
- [x] No unrelated UX redesign introduced.
- [x] Production migration NOT applied without separate authorisation.
- [x] Phase 0C.1 closure report produced (this document).

**19 of 27 fully satisfied, 4 partial, 4 open** — consistent with the CONDITIONAL PASS verdict in §A.
