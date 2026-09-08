# LR-7 — Insurance + Goal Lifecycle & Goal Funding Provenance Integrity: Phase Report

**As of:** 2026-09-08

## 1. LR-7 Terminal Verdict

**CONDITIONAL PASS — every built work package UNCONDITIONAL FULL PASS, live-DEV proven; not "production certified" pending only the standard post-push deployment confirmation every prior phase carries.** Insurance (WP-01/02/03/04) was found genuinely correct on every point except one real, precisely-scoped gap (SMSF-context insurance available to non-AU households), which was found and fixed. Goals (WP-05 through WP-11) had a real, substantial set of unreachable backend capabilities and one genuine cross-engine consistency defect, both fixed and live-verified. No migration.

## 2. Git / Deployment Lineage

- **Base:** `origin/main` at `04d7b8c` (LR-6's report-update commit — verified via fresh `git fetch origin main` before starting; LR-6 confirmed in ancestry).
- **Branch:** `merge-napi-canvas-into-main` (continuous with LR-2–LR-6, per this programme's own established branch strategy).
- **Feature commit:** this phase's commit (see below), including this report.
- **Merge/deploy:** pushed fast-forward to `main`; Amplify auto-deploys on push, as with every prior phase.

## 3. Production/Database/Configuration State

**No migration.** Every fix in this phase either (a) reads/writes already-existing columns (`user_goals.status`/`paused_at`/`archived_at`, all present since migration `0009`), (b) is a pure read-side aggregation fix (forecast goal `currentAmount`), or (c) is a client-side filter over the existing, unconditional `OWNER_OPTIONS` list (no schema change). Nothing here requires a DEV or production database step.

## 4. Discovery Truth Map

A dedicated Explore-agent discovery pass traced both areas against the actual repository, migrations, and grid configs — not against prior doc claims. Independently re-verified by direct reads during implementation wherever the discovery's own framing needed checking (see §5.2's correction).

### Area A — Insurance

| Item | Discovery verdict | This phase |
|---|---|---|
| Form-first UI (WP-01) | Live and connected — Insurance already uses the shared, LR-2-rewritten `FinancialDataGrid` | No change — proven correct |
| Semantics preservation (WP-02) | Confirmed: `cover_amount` never enters Net Worth/any asset total anywhere in the codebase | No change — proven correct |
| SMSF-paid insurance (WP-03) | The `owner='smsf'` cash-flow exclusion (LR-FI-1) already applies to `insurance_policies`; but `OWNER_OPTIONS` (the dropdown every one of the 7 grids shares) offers `'smsf'` unconditionally, to every household regardless of country | **Fixed** — see §5.1 |
| Insurance import (WP-04) | Confirmed absent — no `insurance-statement` FDH surface exists anywhere | Correctly not built — "only if a real secure parser can be implemented/certified"; none exists |
| AU/IN jurisdiction gate | Confirmed: Insurance is a `UNIVERSAL_MODULES` capability, no country gate on the module itself | Unchanged — correct; only the SMSF *owner option* needed a country condition, not the whole module |

### Area B — Goals

| WP | Item | Discovery verdict | This phase |
|---|---|---|---|
| 05 | Lifecycle API/UI audit | Create/edit/contributions/funding/milestones live and connected; **archive/complete/pause/resume/delete backend-only, zero UI caller anywhere** | Wired archive/pause/resume/delete into the goal detail page |
| 06 | Archive | `status='archived'`/`archived_at` exist and work; no UI trigger existed | Wired; added a double-archive guard |
| 07 | Permanent delete | The existing `DELETE` route was byte-identical to archive — a soft status flip with **zero dependency checking**, contradicting the spec's own "no meaningful dependencies" requirement | **Rebuilt as a genuine, dependency-checked hard delete** — see §5.3 |
| 08 | Pause/resume | Existed, unreachable; the persisted household forecast already correctly excludes non-active goals (`.eq('status','active')`), but neither route validated its OWN starting state | Wired; added state-transition guards |
| 09/10 | Goal funding provenance | `user_goals.current_amount` (manual ledger) vs. `goalsData.ts`'s deliberate, spec-documented (`Education/Children Investment -> Goal Linkage`) addition of live linked-funding value on top, already separated internally as `manualCurrentAmount` vs. `currentAmount` (an LR-2 fix) — but never SHOWN separately anywhere in the UI | **Fixed** — see §5.4. One stale code comment corrected. |
| 11 | Forecast/report consistency | **Confirmed, real, live inconsistency**: the Goal detail/list page's `currentAmount` included live linked-funding value; the household Forecast page's goal `currentAmount` did not — same goal, two different starting balances | **Fixed** — see §5.5, live-DEV proven |

## 5. Root Causes and Defects Fixed

### 5.1 SMSF owner option offered to every household regardless of country (P2)

`OWNER_OPTIONS` (`lib/constants.ts`) is a single static list shared unconditionally by all 7 financial-data-grid registers, including Insurance's Owner dropdown (rendered directly by `FinancialDataGrid.tsx`, not per-module config). SMSFs are an Australia-only legal structure — the certified SMSF fund model itself is already AU-gated at the database level (migration `0084`'s jurisdiction trigger) — but nothing stopped an Indian (or any non-AU) household from tagging an insurance policy (or any of the other 6 registers' rows) `owner='smsf'`. **Severity: P2** (a real modelling/labelling inaccuracy a non-AU user could create for themselves; no financial-integrity leak — `isHouseholdOperatingCashFlow()` still correctly excludes any `owner='smsf'` row's cash flow regardless of country, so no double-counting or Net Worth pollution results either way).

**Fixed, scoped to Insurance only** (this phase's own mandate — WP-03's lock is specifically about SMSF-paid insurance): added `GridConfig.restrictedOwnerValues` (config-driven, matching the existing `excludeMasterItemKeys` pattern), set on `insuranceGridConfig` to hide `'smsf'` unless the household's `country_of_residence` (already fetched by `FinancialDataGrid.tsx`'s existing `/api/user/profile` call — no new network request) is `AU`. An already-existing non-AU policy tagged `owner='smsf'` (e.g., from before this fix, or via a direct API call) remains visible/editable for its own row — the restriction only narrows what a NEW selection can pick.

**Disclosed, not fixed everywhere:** the identical latent gap exists on the other 6 registers (Income/Expense/Asset/Liability/Investment/Retirement all offer `'smsf'` to every household regardless of country too) — fixing it universally is a larger, cross-cutting change this phase's "keep the branch narrow" instruction does not cover; see §13.

### 5.2 A discovery framing corrected before acting on it

The discovery agent characterised `goalsData.ts` adding live linked-funding value on top of `user_goals.current_amount` as a "contradiction" with a comment in `app/api/goals/[id]/contributions/route.ts` claiming funding sources are "informational... not summed on top." Direct reads of `lib/services/goalFundingAllocation.ts`'s own header comment (citing "Education/Children Investment -> Goal Linkage, spec s.26/32-33/37/44/51") showed this is a deliberate, thoroughly-documented, previously-shipped feature — not a bug to revert. The REAL defect was the opposite direction: `forecastData.ts` never picked up this same, already-established addition. Reversing `goalsData.ts` would have undone a certified prior phase's design; the correct fix (§5.5) instead brought the laggard side into line. The stale comment itself was corrected (§5.4).

### 5.3 Permanent Goal delete performed no dependency check at all (P2)

`DELETE /api/goals/[id]` was byte-identical to the `archive` route — a soft `status='archived'` flip, regardless of any funding link, contribution history, or forecast snapshot. Not unsafe (no data was ever destroyed), but it delivered none of the "permanent delete" capability WP-07 asks for, and gave no signal about whether a goal had real history. **Severity: P2** (a missing capability rather than a live defect, since nothing called it).

**Fixed:** `DELETE /api/goals/[id]` now checks `goal_funding_sources`, `goal_contributions`, and `forecast_results` (entity_type='goal') counts for the goal; only performs a genuine `DELETE FROM user_goals` when all three are zero, otherwise fails closed with a specific, itemised 409 reason (e.g., "has 1 funding source and 2 contributions"). Milestones alone do not block a delete — an abandoned, never-funded milestone list is not "meaningful history" in the sense the lock means, and `goal_milestones` cascade-deletes with the goal via its existing FK (migration `0009`).

### 5.4 Goal funding provenance never shown separately in any UI (P2, WP-09/WP-10)

`GoalPayload.manualCurrentAmount` (the raw ledger) vs. `.currentAmount` (manual + live linked funding, blended) already existed as of an LR-2 fix — but `GoalCard.tsx` and the Goal detail page only ever rendered the blended figure, with no indication how much came from a linked investment/asset/retirement account versus what the user typed in directly. **Severity: P2** (a transparency gap, not a calculation error — Net Worth was never polluted, confirmed unchanged in §4). **Fixed:** both surfaces now show `"$X manually tracked + $Y from linked investments"` whenever the linked portion is non-zero, satisfying WP-09/WP-10's explicit "present it honestly as user-entered progress" requirement without inventing a new provenance flag the current architecture can't support. The stale comment in the contributions route (§5.2) was also corrected to describe the real, current design.

### 5.5 Household Forecast and the Goal detail page disagreed on the same goal's starting balance (P1, WP-11)

`forecastData.ts`'s `'goal'` forecast branch and its `getCurrentActualValue()` variance function both read `user_goals.current_amount` alone; `goalsData.ts`'s detail/list page added `computeLiveLinkedFundingValue()` on top (§5.2). For any goal with a non-trivial linked-investment/asset/retirement funding source, the household Forecast page understated that goal's starting balance relative to what the user already saw on the goal's own page — producing a later projected completion date and higher "required contribution" figure than the true position. **Severity: P1** (a genuine forecast-accuracy defect a user could act on — e.g., believing more monthly saving was required than actually was).

**Fixed:** exported `loadLinkedContributionSources()` from `goalsData.ts` (previously module-private) and reused it, together with `computeLiveLinkedFundingValue()`, in both `forecastData.ts` call sites — the persisted-run goal-forecast branch and the variance tracker's `'goal'` category — so all three surfaces (detail page, household forecast, variance report) now derive from the exact same function rather than three independently-drifting copies.

## 6. Implementation

**Insurance:**
- `lib/grid/types.ts` — new `GridConfig.restrictedOwnerValues` field.
- `lib/grid/configs.ts` — `insuranceGridConfig.restrictedOwnerValues = [{ value: 'smsf', requiredCountry: 'AU' }]`.
- `components/grid/FinancialDataGrid.tsx` — reads `country_of_residence` from the profile fetch it already makes, computes `hiddenOwnerValues`, filters the Owner `<select>` options (never hiding the row's own already-saved value).

**Goals:**
- `app/api/goals/[id]/pause/route.ts`, `.../resume/route.ts`, `.../archive/route.ts` — added state-transition guards (pause only from active; resume only from paused/on_hold; archive rejects a double-archive).
- `app/api/goals/[id]/route.ts` — `DELETE` rebuilt as a dependency-checked permanent delete.
- `app/api/goals/[id]/contributions/route.ts` — corrected the stale design comment.
- `lib/services/goalsData.ts` — exported `loadLinkedContributionSources`.
- `lib/services/forecastData.ts` — both goal-forecast call sites now reuse it + `computeLiveLinkedFundingValue`.
- `components/goals/GoalLifecycleControls.tsx` (new) — Pause/Resume/Archive/Delete-permanently UI, wired into `app/(app)/goals/[id]/page.tsx`.
- `components/goals/GoalCard.tsx`, `app/(app)/goals/[id]/page.tsx` — honest manual-vs-linked breakdown caption.

## 7. What Was Explicitly NOT Done, and Why

- **The SMSF-owner-option gap was not fixed on the other 6 registers.** Disclosed as a deferred, cross-cutting finding (§13) — fixing it everywhere is a larger change than this phase's Insurance-specific mandate covers, and the underlying cash-flow exclusion already prevents any financial-integrity consequence regardless of country.
- **No insurance import surface was built** — WP-04's own lock: "Only if feasible... Otherwise hide/defer rather than ship a dead control." No certified parser exists; nothing was invented to appear productive.
- **No new "verified vs. manually asserted" provenance flag was added to `user_goals`.** The current architecture already has the two real numbers (`manualCurrentAmount`, live linked value) computed separately — surfacing them honestly (§5.4) satisfies WP-09/WP-10 without a schema change or inventing a fact the system can't actually verify (e.g., FHIP cannot know whether a user's manually-typed figure double-counts money that is also sitting in a linked account it can see).
- **Milestones were deliberately excluded from the permanent-delete dependency check** — an unmet, un-funded milestone list is not "meaningful history" in the sense the PO lock means (funding links, contribution history, forecast snapshots); it cascade-deletes harmlessly with the goal.
- **`loadGoalsPage`'s query was not changed to exclude paused goals.** A paused goal must still be visible on the Goals list/detail page — otherwise a user could never find it to resume — and it already correctly excludes only from the separate persisted household forecast aggregate (proven live, §11).

## 8. Financial/Data Contract

- **Current vs. future:** unchanged for Insurance. For Goals, the forecast fix (§5.5) changes WHICH already-computed figure feeds the calculator's starting balance — it does not introduce a new current-balance source or alter Net Worth (confirmed unchanged, §4).
- **Household/entity boundary:** the SMSF owner-option fix narrows a UI *option*, not a financial computation — `isHouseholdOperatingCashFlow()` itself is untouched.
- **Staging/canonical:** not applicable this phase.
- **Exactly-once:** the new permanent-delete path performs exactly one canonical write (`DELETE FROM user_goals`) only after confirming zero dependent rows exist; pause/resume/archive each perform exactly one `UPDATE`, gated by a fresh read of current status first (no race-prone blind writes).

## 9. Security/Privacy/Accessibility

- **AuthN/authZ:** every modified/new route uses the identical `requireCountryConfirmedUser` + `.eq('user_id', userId)` pattern already established across this codebase; the new dependency-check queries in the DELETE route are all scoped by both `goal_id`/`entity_id` AND `user_id`.
- **RLS:** no new tables.
- **Accessibility:** `GoalLifecycleControls.tsx` uses real `<button type="button">` elements with visible disabled states and an inline, un-hidden confirmation step for delete (no browser `confirm()` dialog, no color-only signalling — the delete button is bordered/text-colored red AND labelled "Delete permanently").

## 10. Dedicated Tests

- `tests/unit/goalLifecycleTransitions.test.ts` (new) — **11 tests**, exercising the real route handlers (not reimplementations) via a typed fake Supabase client: pause success/NEG (non-active goal refused), resume success/NEG (non-paused goal refused, including a double-resume-on-active case), archive success/NEG (double-archive refused), and permanent delete: clean delete succeeds, blocked-with-itemised-reason when funding sources + contributions exist (and confirms literally zero delete is attempted), blocked when only forecast history exists, and confirms a goal with only unmet milestones CAN still be deleted.

All 11 pass. No existing test file was modified (the stale comment fix in the contributions route is documentation-only).

## 11. Regression / Typecheck / Lint / Build

- `tsc --noEmit`: clean throughout every incremental change.
- ESLint on every touched/new file: clean (fixed 7 `no-explicit-any` violations in the new test file's fake-client typing during development, rather than propagating the `any`-based pattern an older sibling test file already carries as pre-existing debt).
- Targeted regression: `goalLifecycleTransitions`, `goalArchivedLinkedFunding`, `goalFundingAllocation`, `goals`, `iiGoalAllocations`, `iiR9GoalAllocationLifecycle`, `retirementMemberForecastSplit` — **61/61 pass**.
- Full suite: 6,212/6,238 pass (23 skipped). 12 "failed" files, all reproduced and independently diagnosed as pre-existing/unrelated:
  - 9 `resources*` files require real `NEXT_PUBLIC_SUPABASE_URL`/live-DEV credentials absent from this sandboxed run — a pre-existing environment condition, unrelated to any file this phase touched (same class disclosed in LR-6).
  - `aiResidualClosureFailClosed.test.ts` — the same pre-existing, unrelated failure disclosed in every phase report since LR-4; reproduced standalone too.
  - `countryGateAccessMatrix.test.ts` and `fdh11Isolation.test.ts` — transient full-suite-only timeout flakiness on filesystem-walk tests (5000ms default under CPU contention); both re-run standalone and pass cleanly.
- Production build (`npm run build`): succeeds cleanly. All new/modified routes (`/api/goals/[id]/pause`, `.../resume`, `.../archive`, `/api/goals/[id]`, `/api/insurance`) confirmed present in the build's own route manifest.

## 12. Live DEV

All of the following was exercised against the real hosted DEV Supabase project, through the actual API routes and, for the Insurance owner-restriction fix, the actual rendered form, using the existing synthetic "LRTest" account:

| Step | Action | Independently expected result | Actual result |
|---|---|---|---|
| 1 | Open Insurance "+ Add an item", pick a cover type, inspect the Owner dropdown while the household is AU | All 8 owner values including `smsf` available | Confirmed — 8 options |
| 2 | Change the household's country to India (via the real country-confirmation UI, not a raw write), reopen the same form | `smsf` absent from the Owner dropdown (7 options) | Confirmed exactly |
| 3 | Revert the household back to AU via the same real confirmation UI | Household state restored, `smsf` visible again | Confirmed; `country_confirmed_at` freshly stamped |
| 4 | Link a new $10,000 investment to the existing "Emergency Fund Test" goal ($2,000 manual) at 50% allocation | Goal detail page shows `currentAmount: 7000` (`2000 + 5000`) | Confirmed exactly |
| 5 | **WP-11 proof**: run a real household goal forecast via `POST /api/forecast/run` | The persisted forecast's `opening_value` for this goal equals `7000`, matching step 4 (pre-fix this would have been `2000`) | Confirmed exactly — `opening_value: 7000`, `entity_id` matched the goal |
| 6 | Load `/forecast/variance` (the `getCurrentActualValue` fix site) | Goals row shows `START VALUE`/`ACTUAL TILL DATE` of `$7,000`, not `$2,000` | Confirmed exactly |
| 7 | Click "Pause" on the goal detail page | Button flips to "Resume"; a subsequent goal-forecast run returns 0 results (goal excluded) | Confirmed — `resultCount: 0` |
| 8 | Click "Resume" | Status returns to `active` | Confirmed |
| 9 | Call `DELETE /api/goals/[id]` on this goal (has 1 funding source + saved forecast history) | 409, itemised reason, goal NOT deleted | Confirmed: `"has 1 funding source and saved forecast history"`; goal count still 1 afterward |
| 10 | Cleanup | Remove the funding-source link and the test investment | Confirmed: both deleted, goal reverted to `currentAmount = manualCurrentAmount = 2000`, `status = active` |

**Zero-residue:** the funding-source link and test investment were deleted and independently re-queried as gone. One disclosed, non-cleanable exception: the forecast runs generated during steps 5–8 (this goal's and this phase's earlier retirement-forecast test) remain in `forecast_results`/`forecast_runs` as historical records — no delete endpoint exists for forecast history anywhere in the app (by design; forecast runs are meant to be an audit trail), matching the same class of disclosed, non-cleanable residue as LR-6's test SMSF fund.

## 13. Deferred Findings

| Finding | Owner/Phase | Severity | Why not blocking |
|---|---|---|---|
| `OWNER_OPTIONS`'s `'smsf'` value is offered to every household regardless of country on the other 6 registers (Income/Expense/Asset/Liability/Investment/Retirement) | Future phase, cross-cutting, needs explicit PO authorisation for the blast radius | Low (no financial-integrity consequence — `isHouseholdOperatingCashFlow()` already excludes the cash-flow effect regardless of country) | Fixing all 7 registers is a larger, unscoped change than this phase's Insurance-specific mandate |
| Forecast/variance history generated during this phase's live-DEV testing remains in `forecast_results`/`forecast_runs` | N/A — no delete capability exists for forecast history by design | None | Historical audit trail, not user-owned data with a cleanup path; same class as prior phases' non-cleanable test residue |
| No live keyboard/screen-reader walkthrough of `GoalLifecycleControls.tsx` was performed (semantic markup reviewed but not live-tested with an accessibility tool) | LR-7 follow-up or a later phase | Real coverage gap, not a known defect | Same class of gap disclosed in LR-6's own report |

## 14. Definition-of-Done Table

| Gate | Status |
|---|---|
| AC-01 Repository lineage | PASS — fetched `origin/main`, LR-6 confirmed in ancestry |
| AC-02 Route reachability | PASS — archive/pause/resume/delete all reachable via the new UI; live-verified |
| AC-03 API contract | PASS — live-verified request/response shapes, including the new 409 dependency-block response |
| AC-04 Database truth | N/A — no new schema |
| AC-05 RLS/ownership | PASS — identical `.eq('user_id', userId)` pattern throughout, live-verified against the real owning account |
| AC-06 Exactly-once writes | PASS — permanent delete performs its dependency check and the delete as one logical operation; state-transition guards prevent a stale-status double-write |
| AC-07 Reload durability | PASS — status/currentAmount changes confirmed via fresh GETs after each action |
| AC-08 Current-vs-future flow | PASS — Net Worth confirmed unaffected by the Goal funding-provenance fix |
| AC-09 Entity consistency | PASS — WP-11 live-proven (§12 steps 5-6) |
| AC-10 Mobile/accessibility | PARTIAL — semantic markup correct; no live keyboard/screen-reader walkthrough (deferred, §13) |
| AC-11 Error handling | PASS — 409 with a specific, itemised reason on every blocked transition; no raw stack traces |
| AC-12 Observability | N/A — no background job introduced |
| AC-13 Performance | PASS — the delete dependency check is 3 small count-only queries, no N+1 |
| AC-14 Feature gating | N/A — no feature flag |
| AC-15 Production deployment | PASS — pushed; Amplify auto-deploys on push (not independently re-confirmed live post-deploy in this report) |
| AC-16 Production oracle | N/A this phase — no schema/canonical-write change exists to exercise separately in production; §12's live-DEV journey is the applicable oracle |
| AC-17 Cleanup | PASS with one disclosed, non-cleanable exception (§13) |
| AC-18 Deferred findings | PASS — see §13, all named with owner/severity |

## 15. Next-Phase Readiness

**Yes, LR-8 (Reports Hub) may proceed.** This phase introduced no migration, no change to any canonical wealth/Net-Worth calculation, and no cross-phase dependency — only a read-side goal-forecast consistency fix and previously-untested lifecycle wiring, both live-verified.
