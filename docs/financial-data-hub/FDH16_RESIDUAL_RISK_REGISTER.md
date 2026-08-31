# FDH-16 — Residual Risk Register

## Defect found and fixed this round

### FDH16-DEF-001

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
  added). **Not independently live-re-proven against real DEV at the 1,001-row boundary** the way `loadDashboard()`
  itself was — this specific query path was fixed by source-inspection-driven pattern-matching once the first
  instance was found, not by reproducing a second live failure. Disclosed honestly as a lower-confidence fix than
  FDH16-DEF-001's own directly-reproduced-and-reproven closure.

## Carried-forward P2/P3 residuals (unchanged by this round, re-confirmed still open where checked)

| # | Residual | Origin | Current status | Severity |
|---|---|---|---|---|
| 1 | AU Investment has no real bridge RPC reachable outside the running Next.js app server — manual-vs-import equivalence for this domain relies on FDH-11/FDH-14's own prior certification, not a fresh real-RPC proof this round. | FDH-15 (residual #1), carried forward | OPEN, unchanged | P2 |
| 2 | No single combined "golden bridge household" spanning Income+Liability+AU-Investment+Retirement via real RPCs in ONE continuous run. This round closed 3 of 4 domains (Income/Liability/Retirement) via `fdh16_manual_vs_import_equivalence_certification.mjs`; AU Investment remains open for the same reason as #1. | FDH-15 (residual #2), partially closed this round | PARTIALLY RESOLVED | P2 |
| 3 | Concurrent Apply, raw-HTTP-replay, and mid-function forced-failure atomicity not fault-injected fresh against real hosted DEV. | FDH-14/15, carried forward | OPEN, unchanged | P2/P3 |
| 4 | FDH-9/10/12's own PGlite certification scripts fail partway through fixture setup (missing MCC-compliant `user_profiles` fields) against the current migration chain. Real RPCs work correctly for country-confirmed users (re-confirmed fresh by this round's own scripts). | FDH-15, carried forward | OPEN, unchanged (test-hygiene only) | P3 |
| 5 | Payslip PDF extraction (`extractPdfPages()`/`pdf-parse`) has no bounded timeout for a non-PDF file with extractable text but no real PDF structure, uploaded with a `.pdf` extension. | FDH-14 (R-14-8) | **Re-confirmed still open this round** (`git log` shows 0 commits to `lib/financial-data-hub/bank-pdf/textExtraction.ts` since FDH-14's own pass) | P2 |
| 6 | Retirement import panel has no "Import Statement" toggle CTA (interaction-pattern inconsistency, not a defect). | FDH-14 (R-14-9) | Unchanged, not re-tested live this round | P3 |
| 7 | "Expenses → Bank Statement import" has no entry point under the Expenses tab (discoverability gap, a real path exists via the generic uploader). | FDH-14 (R-14-10) | Unchanged, not re-tested live this round | P3 |
| 8 | No malware/AV scanning in the upload pipeline; production uploads structurally disabled regardless. | FDH-3 | Unchanged | P2 (bounded) |
| 9 | FDH-1's original RLS-does-not-apply-to-FK-validation finding. | FDH-1 | Unchanged, LOW, not re-exploited this round | P3/LOW |

## New scope gaps disclosed by this round itself (not defects — coverage gaps)

| # | Gap | Severity | Blocks FDH-16? |
|---|---|---|---|
| 10 | Hosted-browser UI smoke (Dashboard/Income/Expenses/Assets/Liabilities/Investments/Retirement/Goals/Scores/DNA/Resilience/Twin/Forecasting/Reports pixel-rendered) was **not** freshly re-run this round — this environment's dev-server preview tool is bound to the Product Owner's own `D:/FHIP` working tree (confirmed via `preview_list`, server stopped immediately on discovery, no navigation performed). REUSED: FDH-14's own 5-surface Playwright smoke. | P2 (coverage gap, not a demonstrated defect) | No |
| 11 | Scores/DNA/Resilience/Twin/Insurance: no live paired manual-vs-import numeric-parity proof this round, only architectural source-inspection (0 `fdh_*` references in `lib/engines/**`). | P2 | No |
| 12 | Forecasting: no live paired manual-vs-import forecast-output parity proof this round, only architectural source-inspection. | P2 | No |
| 13 | Reports: no live report generated and numerically diffed against canonical state for either synthetic household this round. | P2 | No |
| 14 | 5,000/10,000-row scale was not re-run or explicitly re-labelled this round (only 1,000/1,001 was freshly tested, which is also where the one real defect this round found actually lived). | P3 | No |
| 15 | Concurrent/simultaneous-in-flight Apply and live DB-dependency-failure injection not attempted this round (same reasoning as #3 — would risk damaging shared DEV). | P3 | No |

## Severity-gate check (spec §225/§226)

**Zero P0 financial-integrity corruption/double-count defects are open.** FDH16-DEF-001 was found, fixed, and
live-re-proven within this same round (not left open). **Zero P1 exploitable security/privacy/authority defects
are open** — FDH-15's two P1s (`INC-6`/`RET-2`) are DEV-confirmed fixed; this round's own fresh security sweep
found no new P1. All remaining open items are P2/P3, bounded, and documented — consistent with spec §227.

## FDH-13

Admin Governance status: **owned separately by the Admin Redesign workstream**, unchanged by FDH-16. Certified
by FDH-16: **NO**. See `FDH16_COMPLETION_REPORT.md` for the exact program-level verdict this implies.
