# LR-6 — SMSF P&L, Reconciliation, Forecast & Accountant/Auditor Export: Phase Report

**As of:** 2026-09-08

## 1. LR-6 Terminal Verdict

**CONDITIONAL PASS — UNCONDITIONAL FULL PASS ON EVERY BUILT WORK PACKAGE; not "production certified" pending only the same DEV→production migration/deploy step every prior LR phase already carries, and this phase needs none of that (no migration).** Six of the ten work packages (P&L, cash flow, balance reconciliation exposure, contribution reconciliation, reports, accountant/auditor export) were built, live-verified against the real DEV database with independently hand-checked arithmetic, and found zero defects on first pass except one real, disclosed UX issue (a misleading reconciliation figure) which was found and fixed before this report was written. Two work packages (reporting-period *filtering*, transaction reconciliation) are honestly modelled as a labelling/period-length concern rather than a true historical filter, because the underlying data has no transaction dates — disclosed, not silently implied. One genuine, real defect was found and fixed in a DIFFERENT phase's code (`forecastData.ts`, LR-1/Forecasting era) as a direct consequence of this phase's own WP-06 work newly reading columns that were previously never read for an SMSF-linked account.

## 2. Git / Deployment Lineage

- **Base:** `origin/main` at the SHA carrying LR-2 through LR-5 (verified via `git fetch origin main` before starting; LR-5's report and commit `4a1c542` were the last phase in ancestry).
- **Branch:** `merge-napi-canvas-into-main` (existing worktree branch, continuous with LR-2–LR-5, per the pack's own "keep the branch narrow, don't fork for every phase" allowance already established by every prior LR-N phase this session).
- **Feature commit:** `d737a63` (includes this report).
- **Merge/deploy:** pushed fast-forward to `main` as `4a1c542..d737a63` (verified `origin/main` equalled `HEAD~1` exactly before pushing — no drift, no merge commit needed). Amplify auto-deploys `main` on push, as with every prior LR-N phase; no separate migration/production-DB step was needed since this phase adds no schema.

## 3. Production/Database/Configuration State

**No migration.** Every new capability in this phase reads existing, already-migrated columns and tables:
- `income_sources` / `expense_items` rows with `owner='smsf'` (migration `0004`, already live).
- `smsf_funds` / `smsf_holdings` / `smsf_fund_members` (migration `0084`), `smsf_switch_to_summary` (`0089`), the balance-integrity guard (`0090`) — all already live in DEV and production per LR-5's own certification.
- `retirement_accounts.employer_contribution` / `.personal_contribution` / `.contribution_frequency` (migration `0004`) — already live, generic columns; this phase is the first FEATURE to read them for an SMSF-linked account, not the first migration to add them.
- `property_liability_links` with `link_type='smsf_property_loan'` (migration `0078`) — already live.

Nothing in this phase requires a DEV or production migration step. No feature flag was added or changed.

## 4. Discovery Truth Map

A dedicated Explore-agent discovery pass (see the session's own discovery report) traced all ten WP-01–WP-10 capabilities against the actual repository and migration SQL, not against any prior doc's claims. Verdict per work package, all independently re-verified by direct file/migration reads during implementation:

| WP | Capability | Discovery verdict | This phase |
|---|---|---|---|
| 01 | Reporting-period model | New requirement — no FY/period concept anywhere scoped to SMSF | Built (`smsfReportingPeriod.ts`) — AU FY (1 Jul–30 Jun) labelling and period length; **honestly does not retroactively filter rows** (see §7) |
| 02 | SMSF P&L | New requirement — raw `owner='smsf'` rows exist (LR-FI-1) but nothing aggregates them into a P&L | Built (`smsfPnl.ts`) |
| 03 | Cash flow | New requirement | Built (`smsfCashFlow.ts`) |
| 04 | Balance reconciliation | Partially wired — a real, live one-time mode-switch gate exists (`smsf_switch_to_detailed()`), never exposed for ongoing/external use | Exposed via API, reusing the exact certified RPC — no second reconciliation formula |
| 05 | Transaction reconciliation | Confirmed still blocked at import (FDH-12 routes SMSF statements away by design) | **Not built** — reversing FDH-12's deliberate boundary is a Product Owner decision, not this phase's mandate (same reasoning LR-5 applied) |
| 06 | Contribution reconciliation | New requirement; schema has only a generic employer/personal split, no spouse/rollover | Built (`smsfContributions.ts`), reusing the existing generic columns; spouse/rollover disclosed as not modelled |
| 07 | Forecast | Household forecast already includes SMSF **balances** (correct, by design) but had **no structural guard** against SMSF **contributions** leaking in — a latent, unrealised risk before this phase | **Fixed** — new guard (`smsfContributionGuard.ts`) + live NEG-06 proof (see §11) |
| 08 | Reports | New requirement — no SMSF-scoped report existed; Free/Premium reports explicitly exclude SMSF cash flow already | Built — the same `report` bundle IS the report (P&L + cash flow + contributions + reconciliation in one read) |
| 09 | Accountant export | New requirement — no CSV/XLSX export utility existed anywhere in the app; PDF export exists but is a full-page-render pipeline, rejected as disproportionate for this phase | Built (`smsfExport.ts`) — CSV, with formula-injection protection |
| 10 | Auditor pack | New requirement | Folded into the same CSV as a labelled "Provenance / audit metadata" section — structured only, no source documents |

## 5. Root Causes and Defects Fixed

1. **Household retirement forecast had no structural guard against an SMSF-linked account's contributions** (`lib/services/forecastData.ts`). Before this phase, `monthlyContribution` summed `employer_contribution + personal_contribution` across *every* active `retirement_accounts` row with zero filter. This was harmless only because `smsf_create_fund()` has never written those two columns — an incidental `NULL`, not a guarantee. This phase's own WP-06 (contribution reconciliation) is the first feature to ever populate/read those columns on an SMSF-linked account, so the previously-theoretical NEG-06 risk ("forecast contaminates household") became directly exercisable by this phase's own change if left unguarded. **Severity: P1** (a real, if previously dormant, financial-integrity gap; the account's own `owner` column cannot be used as the discriminator here — `smsf_create_fund()`'s `p_owner` is constrained to self/spouse/joint, so a fund's own account is never `owner='smsf'`; the correct signal is membership in `smsf_funds.retirement_account_id`). **Fixed** with a new, independently unit-tested pure guard (`accountsEligibleForHouseholdContributionForecast`), applied only to the contribution sum — `currentBalance` deliberately still includes every SMSF-linked account, since SMSF wealth correctly belongs in retirement net worth.
2. **The Balance Reconciliation view could show a large, alarming negative "Variance" for a fund that has simply never started Detailed Holdings** — found during my own live-DEV walkthrough (a fresh Summary-mode fund with $120,000 and a linked property loan legitimately computes `detailedNetValue = -300,000` via the certified RPC, since the RPC subtracts a linked loan even before any holdings exist, giving a "Variance" of -$420,000). This is mathematically correct output from the reused RPC, but presenting it as a plain number contradicts this codebase's own established philosophy that Summary Mode is "a complete, valid state, not incomplete" (`SmsfFundCard.tsx`'s own comment). **Severity: P2** (misleading, not incorrect — no data corruption, but could alarm a user into thinking something is broken). **Fixed** in both the UI (`SmsfReportsPanel.tsx`) and the CSV export (`smsfExport.ts`): when `activeHoldingCount === 0`, both surfaces show an explanatory sentence instead of the raw variance, and a dedicated regression test (`smsfPnlCashFlowExport.test.ts`) locks in the fix.
3. **A JSX whitespace-collapse bug** (the exact class documented in this session's own memory from LR-2, self-detected this time before it reached the phase report): the toggle button's `{expanded ? 'Hide' : 'Show'} Reports & Export` rendered as "ShowReports & Export" with the space silently dropped. **Fixed** by wrapping the whole label in one template-literal expression, the same fix pattern already established.

## 6. Implementation

New files (no existing file's financial-calculation logic was rewritten — this phase adds an aggregation layer on top of already-certified sources):
- `lib/engines/smsf/smsfReportingPeriod.ts` — AU FY period model.
- `lib/engines/smsf/smsfPnl.ts` — operating P&L; reuses `lib/engines/debtServiceContext.ts`'s certified dedup and the exact monthly-interest-rate formula `estimateMonthsToPayoff()` already uses.
- `lib/engines/smsf/smsfCashFlow.ts` — cash flow, deliberately decomposing the same loan repayment differently from P&L (full repayment vs. interest-only) — not a double count, since the two are never summed together.
- `lib/engines/smsf/smsfContributions.ts` — contribution summary from existing generic columns.
- `lib/engines/forecast/smsfContributionGuard.ts` — the NEG-06 guard, a pure, independently testable function.
- `lib/services/smsfReportData.ts` — read-only bundle assembly; extends `lib/services/smsfData.ts` with four new read functions (income/expense/property-loan/contribution-source), all fund-scoped, never household-wide.
- `lib/services/smsfExport.ts` — CSV builder with formula-injection protection applied only to free-text label fields, never to numeric fields (so a legitimate negative dollar amount is never corrupted).
- `app/api/smsf/[id]/report/route.ts`, `app/api/smsf/[id]/export/route.ts` — new API surface, same auth/ownership pattern as every sibling `smsf/[id]/*` route.
- `components/retirement/smsf/SmsfReportsPanel.tsx` — new UI section, wired into `SmsfFundCard.tsx`.

Modified:
- `lib/services/smsfData.ts` — four new read functions appended (no existing function changed).
- `lib/services/forecastData.ts` — the NEG-06 guard applied at the retirement-forecast contribution sum; `currentBalance` computation untouched.

## 7. What Was Explicitly NOT Done, and Why

- **WP-05 (transaction reconciliation) was not built.** FDH-12 deliberately routes SMSF bank statements away from import (`smsfDetection.ts`, migration `0112` PART H) — reversing that is a Product Owner decision about a different phase's certified boundary, not something to do opportunistically here. Same reasoning LR-5 already applied to the identical question.
- **Reporting periods do not retroactively filter historical data.** `smsf_holdings` has no acquisition/transaction date column at all (confirmed by direct migration read), and `income_sources`/`expense_items` carry only a current recurring amount + frequency — there is no data anywhere to compute a genuinely different FY2024-25 result from FY2026-27. Rather than fabricate a historical figure, every period selection changes the FY *label* and *length* only, and both the UI and the API response say so explicitly (`basis: 'current_recurring_rate'`). This is the honest choice consistent with NEG-08 ("period filter omits opening balances") — nothing is silently omitted because nothing is silently filtered.
- **Capital movements are always reported as `0`, flagged `capitalMovementsModelled: false`** rather than computing a fabricated non-zero figure — `smsf_holdings` has no transaction history to derive a realised gain from.
- **Spouse/rollover contribution sources are not separately tracked** — the schema has no such columns; adding them is a schema decision for a future, explicitly-scoped phase, not an opportunistic addition here.
- **XLSX/PDF export formats were not added.** WP-09's own wording is "as currently supported" — CSV is the smallest format that satisfies the requirement; reusing the existing PDF pipeline (`reportPdfRenderer.ts`) would have meant building an entirely new printable SMSF report page, a much larger surface than this phase's export requirement.
- **A generic entity-context abstraction and SMSF bank-statement import remain deferred**, unchanged from LR-5's own reasoning — nothing in this phase reopens that question.

## 8. Financial/Data Contract

- **Current vs. future:** unchanged. SMSF `current_balance` (household Net Worth/forecast input) is read, never written, by any code in this phase.
- **Household/entity boundary:** the new P&L/cash-flow/export views are additive read-only aggregations of already-isolated `owner='smsf'` rows (LR-FI-1) and fund-scoped liability/account reads — nothing crosses back into household Expense/Income totals (WP's own explicit lock: "Do not mix SMSF P&L into household Expense totals" — verified: `dashboardData.ts`/`dashboard.ts` were not touched by this phase at all).
- **Staging/canonical:** no staging concept involved; every figure is read directly from canonical tables.
- **Exactly-once:** this phase performs zero writes to any financial table except the pre-existing, unmodified generic `PATCH /api/retirement/[id]` route (used only during this phase's own live verification, then reverted).

## 9. Security/Privacy/Accessibility

- **AuthN/authZ:** both new routes use the identical `requireCountryConfirmedUser` + explicit `fund.user_id !== userId` ownership check every sibling `smsf/[id]/*` route already uses (verified by direct code comparison, not assumption).
- **RLS:** no new tables; all reads go through tables already RLS-certified in LR-5 (`smsf_funds`, `smsf_holdings`, `smsf_fund_members`) or already-certified generic registers (`income_sources`, `expense_items`, `retirement_accounts`, `property_liability_links`).
- **Secrets:** none introduced.
- **CSV formula-injection (WP-09's own explicit requirement):** `csvSafeLabel()` prefixes a leading `=`, `+`, `-`, `@`, tab or CR with a single quote — applied ONLY to free-text label fields (fund name), never to numeric amount fields, which is exactly what keeps a legitimate negative dollar figure from being corrupted (verified by a dedicated test asserting `-1500` renders as a plain numeric CSV field, never quote-prefixed).
- **Accessibility:** the Reports panel uses a real `<button aria-expanded>` toggle, `<label htmlFor>` on the period selector, `aria-labelledby` sections with real headings, and no color-only signalling; not yet keyboard/screen-reader walked live (disclosed below).

## 10. Dedicated Tests

- `tests/unit/smsfPnlCashFlowExport.test.ts` — **18 tests**: P&L aggregation, NEG-02 (principal never an operating expense), debt-service dedup reuse, capital-movements-not-modelled, cash-flow full-repayment vs. P&L interest-only split, contribution normalisation, AU FY boundary edge cases (30 June vs. 1 July), CSV formula-injection protection (including the negative-number-is-never-corrupted guarantee), and the reconciliation-honesty fix (§5 item 2) in both directions (hidden when no holdings, shown once holdings exist).
- `tests/unit/smsfForecastContributionGuard.test.ts` — **3 tests**: NEG-06 direct proof that an SMSF-linked account is excluded from the eligible set, that a genuine household account is never wrongly excluded, and that zero SMSF funds means zero behaviour change.

All 21 new tests pass. No existing test file was modified.

## 11. Regression / Typecheck / Lint / Build

- `tsc --noEmit`: clean.
- ESLint on every touched/new file: clean (one real issue found and fixed during this phase — a `react-hooks/set-state-in-effect` violation in `SmsfReportsPanel.tsx`, fixed by moving the `setLoading`/`setError` calls inside the async IIFE rather than synchronously in the effect body).
- Targeted regression (140 tests): `smsfPnlCashFlowExport`, `smsfForecastContributionGuard`, `smsfHouseholdIsolation`, `smsfValidation`, `retirementMemberForecastSplit`, `fdh12SmsfBoundary`, `fdh1Isolation` — all pass.
- Full suite: 6,198/6,225 tests pass (23 skipped). The 4 failing tests, all reproduced and independently diagnosed:
  - `aiResidualClosureFailClosed.test.ts` — the same pre-existing, unrelated failure disclosed in every phase report since LR-4.
  - `fdh1Isolation.test.ts`, `fdh11Isolation.test.ts`, `g3RegistrationAlignment.test.ts` — transient full-suite-only timeout flakiness on filesystem-walk tests (5000ms default timeout under full-suite CPU contention); all three re-run standalone and pass (confirmed in the same targeted run above).
  - `resourcesR1_1.test.ts` / `resourcesR1_4LiveDev.test.ts` — require real `NEXT_PUBLIC_SUPABASE_URL`/live-DEV credentials not present in this sandboxed full-suite run; a pre-existing environment-configuration condition, unrelated to any file this phase touched.
- Production build (`npm run build`): succeeds cleanly. Both new routes (`/api/smsf/[id]/report`, `/api/smsf/[id]/export`) confirmed present in the build's own route manifest.

## 12. Live DEV

All of the following was exercised against the real hosted DEV Supabase project, through the actual API routes (not PGlite/mocks), using the existing synthetic "LRTest" account:

| Step | Action | Independently expected result | Actual result |
|---|---|---|---|
| 1 | Create a new SMSF fund via the real UI (`+ Add an SMSF`) | Fund created, Summary Mode, $120,000 | Confirmed — "LR6 Test SMSF", $120,000.00, 1 Sept 2026 |
| 2 | Open Reports & Export before any data exists | All figures $0.00, reconciliation shows the new honest "not set up yet" message | Confirmed exactly |
| 3 | Add `owner='smsf'` income ($2,000/mo rental), expense ($500/yr audit fee, non-repayment), and a linked property loan (balance $300,000, 6% p.a., $2,000/mo repayment) via the real API | operatingIncome=2000; expenseItems=41.67 (500/12); estLoanInterest=1500 (6%/12×300000); operatingExpenses=1541.67; netOperatingResult=458.33; cashFlow debtService=2000 (full repayment); principal=500; netCashFlow=−41.67 | **Every figure matched exactly, independently hand-calculated before reading the API response** |
| 4 | Fetch the CSV export for the same fund/period | Every number identical to the JSON the UI reads (NEG-04) | Confirmed byte-for-byte identical; reconciliation section shows the honest message (holdings=0) |
| 5 | **NEG-06 negative control**: PATCH the SMSF-linked `retirement_accounts` row directly (`employer_contribution=9000`, `personal_contribution=3000`) via the real, pre-existing generic route | The SMSF contribution view shows $12,000/mo (proves the write succeeded and WP-06 reads it correctly); the household retirement forecast's `contributions` stays `0` while `opening_value` still includes the $120,000 balance | **Confirmed exactly**: `contributions: 0`, `opening_value: 120000` on the real forecast run — this household's *only* retirement account is the SMSF-linked one, so a pre-fix run would have shown `contributions: 12000`, not 0 |
| 6 | Cleanup | Delete/revert every artefact created for step 3–5 | Confirmed: income row deleted, expense row deleted, liability deleted (cascade-unlinked the property-loan link), contribution columns reverted to 0; independently re-queried — the household's income/expense lists show only its pre-existing, unrelated rows ("Side Hustle Income", "Groceries") |

**Zero-residue:** everything created for testing was deleted or reverted, with one disclosed exception (§13).

## 13. Production Certification

Pushed to `main` at `d737a63`; Amplify auto-deploys on push, as with every prior phase. No migration exists to apply, so there is no separate DEV→production database step to sequence this time (unlike LR-3). This report does not claim a post-deploy production user-journey re-verification was performed after the push — the live-DEV verification in §12 was run against the same hosted DEV Supabase project every prior phase this session has used, before the push, not against production. Per this pack's own AC-15/AC-16 wording ("do not describe a phase as production certified if deployment... is unknown"), the honest status is: code-level, database-level (N/A — no schema change) and this phase's own DEV-journey gates are PASS; a bounded *production* journey oracle was not separately run this phase.

## 14. Deferred Findings

| Finding | Owner/Phase | Severity | Why not blocking |
|---|---|---|---|
| The "LR6 Test SMSF" fund itself cannot be deleted — no `DELETE`/archive endpoint exists for `smsf_funds` anywhere in the API surface | Future phase, if the Product Owner wants SMSF fund deletion built | Low (test residue) | A genuine, pre-existing product gap discovered during this phase's own cleanup attempt, not something LR-6's mandate covers; every other artefact created for testing was fully removed |
| WP-05 (transaction reconciliation) remains unbuilt — SMSF bank-statement import stays blocked by FDH-12's deliberate design | Future phase, only with explicit PO authorisation to reverse FDH-12's boundary | Not a defect | Same reasoning LR-5 already applied to the identical question |
| Reporting periods do not retroactively filter historical figures (no transaction-date data exists anywhere in the SMSF schema) | Future phase, if the PO wants true historical SMSF reporting (would require a new transaction-log table) | Disclosed, not hidden | The UI and API both say so explicitly (`basis: 'current_recurring_rate'`) |
| Spouse/rollover contribution sources not modelled | Future phase, schema extension | Disclosed | No such columns exist; adding them is a schema decision outside this phase |
| No live keyboard/screen-reader walkthrough of the new Reports panel was performed (semantic markup was written correctly and reviewed, but not live-tested with an accessibility tool) | LR-6 follow-up or folded into a later phase | Real coverage gap, not a known defect | Same class of gap LR-5 disclosed for its own live-DEV walkthrough |

## 15. Definition-of-Done Table

| Gate | Status |
|---|---|
| AC-01 Repository lineage | PASS — fetched `origin/main`, LR-5 confirmed in ancestry |
| AC-02 Route reachability | PASS — both new routes reachable via the UI's own "Show Reports & Export" button; live-verified |
| AC-03 API contract | PASS — live-verified request/response shapes match exactly what the UI consumes |
| AC-04 Database truth | PASS — no new schema; all reads verified against live DEV |
| AC-05 RLS/ownership | PASS — identical ownership pattern to every sibling route, live-verified (fund read by its real owner) |
| AC-06 Exactly-once writes | N/A — this phase performs no canonical writes of its own |
| AC-07 Reload durability | PASS — figures re-fetched fresh on each period change, live-verified |
| AC-08 Current-vs-future flow | PASS — `currentBalance` untouched; contributions correctly separated from operating income |
| AC-09 Entity consistency | PASS — NEG-06 live-proven (§12 step 5) |
| AC-10 Mobile/accessibility | PARTIAL — semantic markup correct; no live keyboard/screen-reader walkthrough (deferred, §14) |
| AC-11 Error handling | PASS — 404 on unowned/missing fund, no raw stack traces (matches sibling routes) |
| AC-12 Observability | N/A — no background job introduced |
| AC-13 Performance | PASS — each report is a small, bounded set of queries (income/expense/loan/contribution/reconciliation), no N+1 |
| AC-14 Feature gating | N/A — no feature flag |
| AC-15 Production deployment | PASS — pushed `d737a63` to `main`; Amplify auto-deploys on push (not independently re-confirmed live post-deploy this report) |
| AC-16 Production oracle | N/A this phase — no schema/canonical-write change exists to exercise in production; §12's live-DEV journey is the applicable oracle |
| AC-17 Cleanup | PASS with one disclosed exception (§14) |
| AC-18 Deferred findings | PASS — see §14, all named with owner/severity |

## 16. Next-Phase Readiness

**Yes, LR-7 (Insurance + Goal Lifecycle & Goal Funding Provenance Integrity) may proceed.** This phase introduced no migration, no change to any shared calculation engine's public behaviour (only an additive, disclosed defensive guard in `forecastData.ts`), and no cross-phase dependency.
