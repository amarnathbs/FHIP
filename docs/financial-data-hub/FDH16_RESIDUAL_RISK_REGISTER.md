# FDH-16 — Residual Risk Register

## Defects found and fixed (across both rounds)

### FDH16-DEF-001 (original round)

- **Severity**: P2 (financial-integrity-adjacent scale defect — bounded: requires >1,000 active rows in a
  single register for one user, which no real household currently approaches, but the failure mode itself —
  silent truncation, not an error — is exactly the class spec §168/§206 names as a required negative control)
- **Domain**: Dashboard / Net Worth / Cashflow (canonical calculation layer, `lib/services/dashboardData.ts`)
- **Detected by**: FDH-16's own fresh 1,000/1,001 boundary certification (`scripts/fdh16_scale_1000_1001_certification.mjs`),
  built specifically to close the §247 "1000/1001 must be fresh" requirement.
- **Reproduction**: Created 1,000 then 1,001 `expense_items` rows for one synthetic AU user via a real
  authenticated JWT. A raw, unpaginated PostgREST request against this exact DEV project is silently capped at
  1,000 rows (`content-range: 0-999/1001` — the header proves the server knows the true total but the body only
  returns 1,000). `lib/services/dashboardData.ts`'s `loadDashboard()` had **no `.range()` on any of its 8
  register queries** (income/expenses/assets/liabilities/investments/retirement/insurance/goals), so it inherited
  this cap silently.
- **Live DEV**: Reproduced live, twice (pre-fix run showed `retrieved=1000` at 1,001 rows; the real
  `computeDashboard()` fed that truncated array computed `totalMonthlyExpenses=1000`, silently $1 short of the
  true $1,001).
- **Financial/integrity impact**: Any household whose active row count in any ONE register exceeds 1,000 would
  have Dashboard/Net-Worth/Cashflow totals silently computed from an incomplete set — no error surfaced, the
  missing rows simply vanish from every downstream total (Dashboard, and — per the shared `computeDashboard()`
  dependency confirmed by source grep — anything else that reuses `loadDashboard()`'s output).
- **Why previous certification missed it**: FDH-11/FDH-14's own scale certifications tested 1,000/1,001 for
  their own specific domains (Investment Intelligence's paginated repositories), which already had explicit
  `.range()` handling (confirmed present in `lib/services/investment-intelligence/pagination.ts`) — the
  Dashboard's own aggregate loader was never itself scale-tested at this boundary in any prior FDH round.
- **Negative control**: `SCALE-1001-NEGATIVE-CONTROL` in the same script proves the underlying raw-PostgREST
  truncation is real and reproducible (not an artefact of this script's own logic) — it is asserted as an
  expected, permanent finding about the platform, not "fixed" (the app-layer fix is what changes, not
  PostgREST's own default).
- **Root cause**: No `.range()`/pagination on any of `loadDashboard()`'s 8 register queries; `computeDashboard()`
  has no way to detect a suspiciously-short result and cannot re-request missing rows itself.
- **Fix**: Added a `fetchAllRows()` helper to `lib/services/dashboardData.ts` that pages through in batches of
  1,000 via `.range()` until a short page confirms completeness, applied to all 8 previously-unbounded queries.
  `financial_snapshots` (deliberately `.limit(12)`) and the single-row `user_profiles`/`forecast_global_assumptions`
  lookups were left untouched (not a scale risk by design).
- **Regression**: `npx tsc --noEmit` 0 errors before and after; full `vitest` suite re-run (see
  `FDH16_LIVE_DEV_CERTIFICATION.md` for the exact count) — one pre-existing fake-Supabase-client test fixture
  (`tests/unit/goalArchivedLinkedFunding.test.ts`, which routes through `loadDashboard()` via
  `computeGoalsPagePayload()`) needed a `.range()` method added to its in-memory mock builder to match the real
  interface — a faithful test-fixture update (slices exactly like the real one would at small scale), not a
  weakening; the test's original 7 assertions still hold and now pass again. `npm run build` re-run clean.
  `fdh16_dashboard_engine_live_proof.mjs` (8/8) and `fdh16_manual_vs_import_equivalence_certification.mjs`
  (33/33) both re-run clean after the fix, confirming no regression to the normal (small-scale) case.
- **Live re-proof**: `SCALE-1000-FIX`/`SCALE-1001-FIX` in the same script call the real, fixed, imported
  `loadDashboard()` (not a reimplementation) with a service-role-backed client for the exact synthetic user —
  `totalMonthlyExpenses` correctly reads `1000` and then `1001` post-fix. **6/6 PASS.**
- **Second confirmed instance, same root cause, fixed in the same pass**: `lib/services/reportSnapshotResolver.ts`'s
  Premium report data loader had the identical unpaginated-query pattern on 6 queries (investments, insurance_policies,
  assets, liabilities, income_sources, expense_items) feeding the Premium report. Fixed by exporting `fetchAllRows`
  from `dashboardData.ts` and applying it here too — the shared-layer fix rule (spec §244: "fix shared defects in
  the canonical shared layer, do not patch downstream symptoms individually") was followed by centralising the
  pagination helper in one place and reusing it, rather than writing a second bespoke implementation. Regression:
  `tsc` 0 errors, the two report tests that exercise this resolver
  (`tests/unit/reportSectionsPremiumStressApplicability.test.ts`, `tests/unit/reportsIIChapters.test.ts`) both
  pass (18/18) unchanged — their shared fake-Supabase fixture (`tests/unit/support/fakeSupabaseClient.ts`) already
  had a `range: noop` passthrough, so no fixture update was needed here (unlike the Dashboard fix's
  `goalArchivedLinkedFunding.test.ts` fixture, whose own bespoke fake builder needed a real `.range()` method
  added). **RESOLVED this targeted final-closure round**: previously not independently live-re-proven against
  real DEV at the 1,001-row boundary — now closed by `scripts/fdh16_report_resolver_scale_certification.mjs`
  (12/13 PASS, real `resolveReportSourceData()` invoked directly, real 1,000/1,001 boundary on both
  `expense_items` and, as a secondary register, `investments`). See `FDH16_REPORT_INTEGRATION_CERTIFICATION.md`.

### FDH16-DEF-002 (this targeted final-closure round, 2026-09-01)

- **Severity**: P2 (fail-closed-contract regression, not fail-open, not a demonstrated security/financial-
  integrity exploit — see impact below)
- **Domain**: Module 11.0 AI context certification (`lib/ai/context/financialContextObject.ts`)
- **Detected by**: this round's own item-8/item-6 regression pass — running `tests/unit/aiResidualClosureFailClosed.test.ts`
  (Module 11.0's own existing, previously-passing certification suite) fresh against this candidate, then
  checking the result against a clean `origin/main` baseline (a temporary worktree, `git worktree add`, node_modules
  junctioned to avoid a full reinstall) before assuming the failure was pre-existing, per this round's own
  explicit instruction not to silently wave away a new failure.
- **Reproduction**: `origin/main` (pre-FDH16-DEF-001): 18/18 PASS. This candidate branch (post-FDH16-DEF-001, pre-
  this-round's-fix): 10-11 of 18 tests failed with an uncaught `Unknown Error: terminating connection due to
  administrator command` (Postgres code `57P01`, the fake client's simulated DB-outage error) instead of the
  expected structured `INVALID` context object.
- **Root cause**: FDH16-DEF-001's `fetchAllRows()` fix made `loadDashboard()`'s register queries **throw** on a
  PostgREST read error (correct — no more silent truncation), where the pre-fix unpaginated queries never threw
  (they coalesced a failed read to `data ?? []`). `buildFinancialContextObject()` calls `loadDashboard()`
  completely unguarded — unlike its sibling calls to `loadHealthScore`/`loadFinancialDna`/`loadResilience`/
  `computeGoalsPagePayload`, each already wrapped in its own `try/catch` specifically for this reason. Once
  `loadDashboard()` could throw, the whole function rejected uncaught, well before its own
  `integrity.readFailures`-driven fail-closed gate (`buildSourceFailureContext()`, populated independently by
  `certifiedSourceClient`'s read-observing wrapper) ever got a chance to run.
- **Impact — NOT a live fail-open**: the two real callers of `buildFinancialContextObject()`
  (`app/api/internal/ai/context/{validate,preview}/route.ts`) both already wrap it in their own `try/catch` and
  return a 500 either way — no fabricated data and no unauthorised provider call was ever reachable through this
  regression. The break was to Module 11.0's own internal per-domain-`INVALID` contract (a structured object
  with every domain marked `INVALID`), not to the end-to-end security guarantee.
- **Fix**: wrapped the `loadDashboard()` call in `financialContextObject.ts` in the same try/catch pattern as its
  siblings, falling back on failure to an explicit, well-typed all-empty `DashboardSummary` (via
  `computeDashboard()` over empty registers — never a hand-rolled literal, so it can never silently drift from
  the real engine's shape). The pre-existing `integrity.readFailures.length > 0` gate still fires correctly
  afterwards and returns the fail-closed `buildSourceFailureContext()` before the fallback dashboard is ever used
  for anything a provider could see.
- **Regression**: `tsc --noEmit` 0 errors. `tests/unit/aiResidualClosureFailClosed.test.ts`: 17/18 PASS (up from
  a pre-fix 7-10/18, non-deterministic depending on module-cache/test-order within the same file).
- **One disclosed residual, not fixed (scope boundary, not a live defect)**: test `A4` (negative control) also
  asserts `canonicalWrites(h).length > 0` alongside its two decisive assertions (both of which pass: certification
  status is `PARTIAL`, and the provider IS invoked when the gate is bypassed — proving the negative control is
  not vacuous). The incidental write-count assertion no longer holds, because `loadDashboard()`'s own end-of-
  function `financial_snapshots` upsert is now unreachable one step earlier (its `Promise.all` rejects before
  reaching the upsert) even with the certification gate deliberately bypassed for this test. This makes the
  real-world behaviour **strictly safer** than when the test was written (one more failure mode is now
  unreachable one layer earlier), not less safe. `tests/unit/aiResidualClosureFailClosed.test.ts` is a Module
  11.0-owned test file; per this round's explicit scope boundary (do not reopen another completed module's
  certification), it was not edited. Not blocking — disclosed here as a known, narrow, non-live test-fixture
  staleness.
- **Fresh regression sweep for similar unguarded `loadDashboard()` call sites**: every other call site
  (`lib/services/{financialDnaData,forecastData,goalsData,recommendationsData,reportSnapshotResolver}.ts`,
  `app/(app)/dashboard/page.tsx`, `app/(app)/forecast/*/page.tsx`, `app/api/dashboard/summary/route.ts`) either
  (a) is itself already wrapped by a caller's `try/catch` one level up (the DNA/HealthScore/Resilience case,
  exactly the pattern this fix now matches), or (b) is a page/API-route-level call where throwing is
  already the correct, safe, standard behaviour (a 500/error boundary, not fabricated data) — none required
  the same fix.

## Carried-forward P2/P3 residuals (unchanged by this round, re-confirmed still open where checked)

| # | Residual | Origin | Current status | Severity |
|---|---|---|---|---|
| 1 | AU Investment has no real bridge RPC reachable outside the running Next.js app server — manual-vs-import equivalence for this domain relies on FDH-11/FDH-14's own prior certification, not a fresh real-RPC proof this round. | FDH-15 (residual #1), carried forward | OPEN, unchanged | P2 |
| 2 | No single combined "golden bridge household" spanning Income+Liability+AU-Investment+Retirement via real RPCs in ONE continuous run. Both rounds have closed Income/Liability/Retirement (and, this closure round, downstream engine parity on top of them) via real RPCs; AU Investment remains open for the same reason as #1. | FDH-15 (residual #2), partially closed | PARTIALLY RESOLVED | P2 |
| 3 | FDH-9/10/12's own PGlite certification scripts fail partway through fixture setup (missing MCC-compliant `user_profiles` fields) against the current migration chain. Real RPCs work correctly for country-confirmed users (re-confirmed fresh by this and the original round's own scripts). | FDH-15, carried forward | OPEN, unchanged (test-hygiene only) | P3 |
| 4 | Payslip PDF extraction (`extractPdfPages()`/`pdf-parse`) has no bounded timeout for a non-PDF file with extractable text but no real PDF structure, uploaded with a `.pdf` extension. | FDH-14 (R-14-8) | Re-confirmed still open (`git log` shows 0 commits to `lib/financial-data-hub/bank-pdf/textExtraction.ts` since FDH-14's own pass; unchanged this closure round) | P2 |
| 5 | Retirement import panel has no "Import Statement" toggle CTA (interaction-pattern inconsistency, not a defect). | FDH-14 (R-14-9) | Unchanged, not re-tested live this round | P3 |
| 6 | "Expenses → Bank Statement import" has no entry point under the Expenses tab (discoverability gap, a real path exists via the generic uploader). | FDH-14 (R-14-10) | Unchanged, not re-tested live this round | P3 |
| 7 | No malware/AV scanning in the upload pipeline; production uploads structurally disabled regardless. | FDH-3 | Unchanged | P2 (bounded) |
| 8 | FDH-1's original RLS-does-not-apply-to-FK-validation finding. | FDH-1 | Unchanged, LOW, not re-exploited this round | P3/LOW |
| 9 | Investment position-list truncation re-check (§171) beyond REUSED evidence; whole-codebase sweep for a THIRD unrelated unpaginated-default instance beyond the two files this branch touched (`dashboardData.ts`, `reportSnapshotResolver.ts`). | FDH-16 original round, unchanged | OPEN | P3 |
| 10 | Reports list page does not auto-refresh its own client cache immediately after a successful "Generate report" — the new report is visible only after a manual page reload/navigation. Not a data-integrity issue (report content itself is correct); found during this closure round's fresh UI smoke. | NEW — this closure round | OPEN, disclosed, not fixed (out of this round's targeted scope) | P3 (UX polish) |
| 11 | Test `A4`'s incidental `canonicalWrites(h).length > 0` assertion in `tests/unit/aiResidualClosureFailClosed.test.ts` is now stale (see FDH16-DEF-002 above) — the negative control's actual decisive assertions still pass; only this one incidental appendix assertion no longer holds, because real-world behaviour became strictly safer. | NEW — this closure round, surfaced by FDH16-DEF-002's fix | OPEN, disclosed, not fixed (Module 11.0-owned test file, out of scope to edit) | P3 (test-fixture staleness, not a live defect) |
| 12 | `resourcesR1_1.test.ts`'s "customer cannot edit content" test times out (5000ms) intermittently. Independently re-confirmed this closure round to occur IDENTICALLY on a clean `origin/main` baseline (temporary worktree, isolated run) — pre-existing, unrelated to any file this branch touched. | Pre-existing, confirmed via fresh baseline diff this closure round | OPEN, confirmed pre-existing | P3 |
| 13 | `resourcesAdminR1_2.test.ts`'s "draft count increases by exactly 1" assertion flaked once (256 vs 257) when run as part of the full ~4,868-test suite under vitest's parallel-worker execution, racing against other test files that also create/delete draft content in the same shared real-DEV tables. Re-run in isolation immediately after: 26/26 PASS. Neither `dashboardData.ts`, `reportSnapshotResolver.ts`, nor `financialContextObject.ts` (the only files this branch has ever touched) reference resources/draft-content tables. | Pre-existing test-suite parallelism hygiene issue, unrelated to this branch's changes | OPEN, confirmed a parallelism flake, not a regression | P3 |

## New scope gaps disclosed by the original round — STATUS THIS CLOSURE ROUND

| # | Gap (as originally disclosed) | Status after this closure round |
|---|---|---|
| — | Hosted-browser UI smoke not freshly re-run (dev-server preview tool bound to the Product Owner's own working tree). | **CLOSED.** A dedicated `fdh16-candidate-dev` launch config was added (additive, existing entries untouched) pointing at this exact worktree on its own port (3917). Full 14-surface smoke performed fresh — see `FDH16_DASHBOARD_CERTIFICATION.md`. |
| — | Scores/DNA/Resilience/Twin/Insurance: no live paired manual-vs-import numeric-parity proof, only architectural source-inspection. | **CLOSED for Score/DNA/Resilience/Twin/Forecasting** (28/28 PASS, live, real engine loaders, both households — see `FDH16_DOWNSTREAM_MODULE_CERTIFICATION.md`). Insurance remains architectural-source-inspection-only (no FDH evidence path exists for this domain; unchanged, low risk). |
| — | Forecasting: no live paired manual-vs-import forecast-output parity proof, only architectural source-inspection. | **CLOSED** — folded into the same downstream-parity script; `runForecast('net_worth')` baseline net worth identical between households M and I. |
| — | Reports: no live report generated and numerically diffed against canonical state for either synthetic household. | **CLOSED.** A real Premium report was generated (via direct resolver call AND, separately, via the real UI's "Generate report" button against this candidate's own dev server) and diffed against ground-truth DB queries across Income/Expenses/Liabilities/Retirement/Net Worth. $0 unexplained variance — see `FDH16_REPORT_INTEGRATION_CERTIFICATION.md`. |
| — | 5,000/10,000-row scale not re-run or explicitly re-labelled. | **CLOSED (re-labelled)**. Explicitly labelled `REUSED PRIOR CERTIFIED EVIDENCE` this closure round, after confirming (via `git diff origin/main..HEAD --stat`) that the only files this branch has ever touched (`dashboardData.ts`, `reportSnapshotResolver.ts`) are unrelated to where that evidence was produced (Investment Intelligence's own pagination layer). Per this round's own instruction, not re-run. |
| — | Concurrent/simultaneous-in-flight Apply and live DB-dependency-failure injection not attempted (would risk damaging shared DEV). | **CONCURRENT APPLY: CLOSED** — a genuine two-in-flight-simultaneous concurrent Apply was safely fault-injected against real hosted DEV this closure round (10/10 PASS, `fdh9_apply_income_proposal`) — the first FDH round to do this live rather than relying on architectural reasoning alone. **DB-dependency-failure injection: covered by the isolated deterministic test double, re-run fresh this round** (17/18 PASS, 1 disclosed benign residual) — a genuinely destructive live shared-DEV outage remains, correctly, NOT ATTEMPTED — BY DESIGN. |

## Severity-gate check (spec §225/§226)

**Zero P0 financial-integrity corruption/double-count defects are open.** FDH16-DEF-001 was found, fixed, and
live-re-proven within the original round (not left open); its second confirmed instance (the report resolver)
is now ALSO independently live-re-proven, closed this round. FDH16-DEF-002 was found, root-caused, fixed, and
regression-tested within this same closure round. **Zero P1 exploitable security/privacy/authority defects are
open** — FDH-15's two P1s (`INC-6`/`RET-2`) are DEV-confirmed fixed; this round's own fresh security/failure-mode
sweep (including a genuine live concurrent-Apply race and the isolated DB-fault-injection double) found no new
P1 and no fail-open evidence anywhere. All remaining open items are P2/P3, bounded, and documented — consistent
with spec §227.

## FDH-13

Admin Governance status: **owned separately by the Admin Redesign workstream**, unchanged by FDH-16. Certified
by FDH-16: **NO**. Migration `0107` (Admin A0.2 Wave 1 / D-01) falls inside the migration chain FDH-16's own
replay/collision-scan mechanically covers but carries no FDH-16 ownership and no FDH-16 production claim — see
`FDH16_PRODUCTION_PREREQUISITE_MATRIX.md`. See `FDH16_COMPLETION_REPORT.md` for the exact program-level verdict
this implies.
