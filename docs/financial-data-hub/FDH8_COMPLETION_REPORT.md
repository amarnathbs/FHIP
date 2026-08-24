# FDH-8 — Expense Tracker UX & Financial Activity Experience — Completion Report

**STATUS: CONDITIONAL PASS** — implementation, local certification, and full repository regression are genuinely complete; DEV (live Supabase) and production certification are structurally out of reach in this environment/session and are honestly reported as pending, not claimed.

**Branch:** `worktree-agent-a44f9e6f3dcfdbe12` (harness-assigned worktree branch off `main`)
**Starting canonical main:** `982a5f2ae6f8ac32eb89c081ec50ae9503331f9d` ("Merge Retirement Member UI (Self/Spouse Target Retirement Age) into main"), highest migration `0077_retirement_member_target_age.sql`. Re-confirmed unchanged via `git fetch origin main` at report time — no drift during this session.
**Final certified SHA (this branch, not merged):** `e916622c9705c2b21043b866a814621296a5fc0d` (terminal commit, containing this report; `734f129` is the last functional/test commit immediately before it — all verification evidence in this report was gathered against `734f129`'s tree, which the docs-only commit on top does not change)
**Migration(s):** **None.** FDH-8 required no schema change (spec 7 explicitly permits this). Confirmed via `npm run check:migrations` (76 active migrations, unchanged) and `npm run check:migrations:against-main` (0 collisions vs `origin/main`), both re-run immediately before this report.
**DEV:** Not attainable this session — no DEV Supabase credentials exist in this worktree (`.env.local` absent). Substituted with PGlite (real Postgres) DB-level certification — see section 15.
**Production:** Not touched, not pushed, not merged, per standing constraints. See section 18.

---

## 1. Executive Summary

FDH-8 adds a read-only Financial Activity / Expense Tracker experience (Overview, Transactions, Spending, Income, Recurring, Accounts) over the already-certified FDH-3→FDH-7/R7/R8 pipeline. It introduces zero new financial-truth engines: every headline income/expense/net-cash-flow number is produced by calling FDH-7's own certified `computeApprovedFinancialSummary` oracle, never a second definition. The single most scrutinised requirement — that pending/unapproved transactions never silently enter approved totals — is proven with two independent, genuinely-executed negative controls (a pure-function vitest suite and a real-Postgres PGlite DB script), both passing (26/26 and 12/12). Full-repository regression (2,342 tests) passed with zero FDH-8-caused failures; `tsc --noEmit` and the production `next build --webpack` are both clean (the latter's earlier `xlsx`-module gap was a genuine pre-existing environmental defect, found and fixed as part of restoring a working baseline — see section 17). Live-DEV and production certification are honestly reported as not performed, not rounded up.

## 2. Reuse Audit

See `docs/financial-data-hub/FDH8_REUSE_AND_GAP_AUDIT.md`. Headline finding: FDH-8's only new computation anywhere is grouping/aggregation (by month, merchant, account, category-percentage) around calls into FDH-7's oracle. Zero new ingestion/reconciliation/merchant/category/transfer/duplicate/recurring/approval engines (grep-verified: `financialActivityAnalytics.ts` is the only new file importing `approvedSummary.ts`).

## 3. Information Architecture

See `FDH8_INFORMATION_ARCHITECTURE.md`. Route tree: `app/(app)/financial-data-hub/activity/{page,transactions,spending,income,recurring,accounts}`. One nav entry added to `components/ui/AppShell.tsx` ("Financial Activity", under "Your finances", next to Income/Expenses). No "Review" sub-tab was built — every review surface links into the existing FDH-7 review UI (which does not yet have a dedicated route of its own in this codebase — see section 8's disclosure).

## 4. Financial Overview

See `FDH8_OVERVIEW_UX.md`, `FDH8_APPROVED_ACTIVITY_MODEL.md`. Income/Expenses/Net Cash Flow/Transaction count as primary cards; largest category, recurring count, and a review-status card as secondary; a fixed trailing-6-month trend chart; freshness disclosure (latest transaction date, never an upload date). **The approved/pending disclosure is rendered exactly per spec 12's example** — "Approved activity" cards always shown, a separate "Pending review" card shown only when nonzero pending activity exists, never combined.

## 5. Spending

See `FDH8_SPENDING_EXPERIENCE.md`. Category breakdown (amount/percentage/count) reusing the oracle's own `category_totals`, filtered by R8's category-master `economic_type`. "Needs categorisation" shown separately, never folded into a category. Essential/discretionary split reads the taxonomy field directly, no inference. Top-10 merchants table included (see section 9).

## 6. Income

See `FDH8_INCOME_EXPERIENCE.md`. Same mechanism as Spending, filtered to `economic_type='income'`. Loan proceeds / refunds / transfer credits structurally cannot appear (certified negative controls in section 15).

## 7. Recurring

See `FDH8_RECURRING_EXPERIENCE.md`. Pure display over `fdh_recurring_transactions` — zero detection logic (grep-verified: no `frontendRecurringDetector()` anywhere). `next_expected_date` rendered only when the certified engine populated it.

## 8. Transactions

See `FDH8_TRANSACTION_EXPLORER.md`. Search/filter/sort over `getTransactions()`, deterministic keyset-style ordering (same tie-breaker convention as the existing `bank-transactions`/`review-queue` routes). **Disclosed gap**: no dedicated FDH-7 review/correction page exists anywhere in this codebase yet (confirmed by directory listing — only the FDH-3 upload screen exists under `app/(app)/financial-data-hub/`); every "Review transactions"/"Review/Edit" link falls back to `/financial-data-hub` rather than a nonexistent dedicated route, with this documented inline in the code. This is a real, disclosed UX rough edge, not a financial-integrity issue — no review/correction logic was duplicated to work around it.

## 9. Merchant Experience

See `FDH8_MERCHANT_EXPERIENCE.md` (new doc, added after closing a real gap — see section 20). `getMerchants()` ranks approved expense magnitude, duplicate-excluded, allocation-aware, excluding transfers/loan drawdowns/investment funding/ATM withdrawals by construction. Rendered as a "Top merchants" table on the Spending page. Disclosed: refund-netting is not applied at merchant granularity (FDH-7 defines netting only at the overall `expense_total` level).

## 10. Trends & Comparisons

See `FDH8_TREND_AND_COMPARISON_LOGIC.md`. `getTrend()` buckets approved transactions by month, historical actuals only. `comparePeriods()` handles the zero-denominator case explicitly (`previous=0, current=500` → `percentChange: null`, "New spending this period" label, never `Infinity`/`NaN`) — certified with 6 dedicated test cases. Rendered on Overview as a 6-month trend chart with an accessible text-table summary alongside the chart.

## 11. Multi-Account

See `FDH8_ACCOUNT_EXPERIENCE.md`. Household aggregate + per-account drilldown, both computed from the identical fetched transaction set (never two independently-drifting queries). Transfer-safety across accounts is structural, not a second transfer-detection concept — certified in the "Transfer" oracle scenario.

## 12. Multi-Currency

See `FDH8_MULTI_CURRENCY_POLICY.md`. Every aggregate is an array grouped by `currency_original`; certified with an explicit naive-addition negative control (100 AUD + 100 INR "=200" shown only as the trap it is, never what the certified functions produce).

## 13. Financial Integrity

See `FDH8_FINANCIAL_INTEGRITY_CERTIFICATION.md` and `FDH8_APPROVED_ACTIVITY_MODEL.md` — **the core of this report.** Two independent instruments, both genuinely executed:

```
$ npx vitest run tests/unit/fdh8FinancialIntegrityCertification.test.ts
 Test Files  1 passed (1)
      Tests  26 passed (26)

$ node scripts/fdh8_certification.mjs
=== FDH-8 DB Certification: 12 PASS, 0 FAIL ===
```

Every FAIL condition in spec section 154 was checked with a real negative control and cleared — see the itemised list in `FDH8_FINANCIAL_INTEGRITY_CERTIFICATION.md`. The Product-Owner-flagged critical scenario (pending never silently entering approved totals) was proven at BOTH the pure-function level and the real-Postgres/RLS level, including the exact `$4,250 + $180 ≠ $4,430` example from spec 12.

## 14. Scale

See `FDH8_SCALE_CERTIFICATION.md`. Certified at 1,001 rows (exact `count()`, exact `sum()`, real keyset pagination walk collecting all 1,001 ids with zero duplicates/gaps) — the specific truncation-class boundary the spec calls out. **Not run** at 5,000/10,000 (time-budgeted out this session, disclosed as an Open Residual; the query pattern used has no `LIMIT`/offset-pagination that would behave differently at larger N, but this is a structural argument, not a re-run measurement).

## 15. UX & Accessibility

See `FDH8_ACCESSIBILITY_CERTIFICATION.md`. Semantic `<table>`s with `scope="col"` headers throughout (Transactions, Spending category table, Merchants table, Recurring table, Trend summary table); every chart (`AllocationPieChart`, `TrendLineChart`) paired with an adjacent text-table summary; status conveyed with text + colour, never colour alone; loading/empty/error states via the reused `ResourceLoadingSkeleton`/`ResourceEmptyState`/`ResourceErrorState` components — no page flashes `$0` before real totals load, and a failed component (e.g. a merchants-query error) does not blank an already-successful section next to it (verified by code reading — spending/overview both fetch secondary sections in isolated try/catch blocks). **Not performed**: live keyboard-navigation/screen-reader testing (no browser/AT tooling exercised against an authenticated session in this session) — disclosed, not claimed.

## 16. Live DEV

See `FDH8_LIVE_DEV_CERTIFICATION.md`. **Not attainable** — no DEV Supabase credentials in this worktree. This is the same class of gap FDH-7's own certification script disclosed for itself. Genuinely substituted, as far as it reaches, by the PGlite DB certification (section 13) for the SQL/RLS layer only — no live HTTP walk through the actual Next.js server/session, no real synthetic-CSV-to-Overview end-to-end walk, was performed.

## 17. Security

See `FDH8_SECURITY_CERTIFICATION.md`. Zero new tables/RLS policies. Tenant isolation certified via PGlite with a forged-account-id negative control AND a "no app-layer filter at all, RLS alone" negative control (both pass). No service-role client imported anywhere in FDH-8's own code (grep-verified). No admin transaction browser. No raw-document access. FDH1-F1 residual correctly left open, not claimed closed.

## 18. Data Preservation

`git status --short` after every FDH-8 change touches exactly: 8 new API routes, 9 new/edited UI files, 1 new analytics/period/comparison module, 1 new test file, 1 new certification script, 17 new docs, and a 5-line additive diff to `AppShell.tsx`. Two incidental timestamp-only diffs in `scripts/ii-*-certification/comparison_report.json` (regenerated by an unrelated full `vitest run` pass) were reverted with `git checkout --` rather than committed. No FDH reference data, R8 master/rule table, Investment Intelligence file, Resources file, or Input Data file was touched — confirmed by the diff itself, not merely asserted.

## 19. Regression

- `npm run check:migrations`: OK, 76 active migrations, unchanged.
- `npm run check:migrations:against-main`: OK, 0 collisions vs `origin/main`.
- `npx tsc --noEmit -p tsconfig.json`: **0 errors**, full repository (confirmed clean before and after fixing the pre-existing `xlsx` gap — see section 20).
- `npx eslint` on every new/touched FDH-8 file: **0 errors, 0 warnings** (verified per-directory: `lib/financial-data-hub/analytics`, `app/api/financial-data-hub/activity`, `app/(app)/financial-data-hub/activity`, the new test file). `AppShell.tsx`'s one pre-existing lint error was confirmed (via `git stash` comparison, done independently by the UI implementation pass) to already exist before FDH-8's one-line addition — not introduced by this phase.
- `npx vitest run` (full repository): **2,342 passed, 18 skipped, 2 failed** — both failures are pre-existing live-DEV-credential-gated tests (`resourcesImportR1_7LiveDev.test.ts`, `resourcesP0ContentR1_7CLiveDev.test.ts`, both `ENOENT .env.local`), unrelated to FDH-8 and consistent with the same missing-credentials gap disclosed in section 16.
- FDH-6/FDH-7/R8 scoped regression re-run individually: **234/234 passed** (11 test files: `fdh6IndependentCertificationPack`, `fdh6Pagination`, `fdh6ReviewReasons`, `fdh6ThresholdsAndRuleConflict`, `fdh7ApprovalPolicy`, `fdh7ApprovedSummaryOracle`, `fdh7SchemaContract`, `r8RuleMatchingAndEconomicType`, `r8SchemaContract`, `r8TextMatchAndMerchant`, `r8TransferRefundRecurring`) — zero regression.
- `npx next build --webpack`: **webpack compile succeeded (97s) and the full-project TypeScript check succeeded (60s)** on the final run. Static-page generation then failed on `/admin/benchmarks` — an unrelated, pre-existing admin page that calls `createClient()` at build/static-generation time and fails without real `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` env vars, which this worktree does not have (same root cause as section 16's DEV-credentials gap, not specific to FDH-8, and would fail identically for any build attempted in this environment regardless of what code changed). **No FDH-8 file appears anywhere in the build's error trace at any phase.**

## 20. Production Certification (PENDING HUMAN ACTION)

See `FDH8_PRODUCTION_CERTIFICATION.md`. Not touched. No push, no merge, no deploy. FDH-8 ships no migration, so there is no production migration-application ordering step specific to this phase — but production verification of the actually-deployed routes, and confirmation that FDH-7's own migration 0076 (`approval_status` etc.) is live in production, remain human steps.

## 21. Open Residuals (honest, itemised)

1. **No dedicated FDH-7 review page exists in this codebase** — every "Review transactions" link falls back to `/financial-data-hub`. Not an FDH-8 defect; a pre-existing gap this phase correctly did not paper over by building a second review UI.
2. **Live DEV / real Supabase certification not performed** — no credentials in this worktree (section 16).
3. **Scale not certified at 5,000/10,000 rows** — only 1,001 (section 14).
4. **Transaction Explorer pagination uses `limit` alone, no cursor param wired at the route level yet** — the underlying data/index support it; the route's cursor plumbing is unbuilt.
5. **Merchant totals do not net refunds** — a deliberate, disclosed scope choice, not a defect (section 9).
6. **The oracle's `'uncategorised'` bucket combines all non-transfer economic types** — inherited from FDH-7, not introduced by FDH-8, disclosed in `FDH8_SPENDING_EXPERIENCE.md`/`FDH8_INCOME_EXPERIENCE.md`.
7. **No subcategory-level drill-down function** — category-level only in this pass.
8. **No dedicated `getCategoryTrend()` convenience function** — composable today from existing functions, not pre-packaged.
9. **No "average spending per day/month/transaction" figure rendered** — deferred rather than risk an ambiguously-labelled number (spec 56's own concern).
10. **Minor code-quality nit, not a financial-integrity issue**: `spending/page.tsx`'s essential/discretionary subtotal uses a plain `.reduce((sum,c)=>sum+c.total,0)` over already-exact, already-rounded category totals for a display-only rollup — not the canonical oracle computation the spec's "no reduce" rule targets (section 82), but inconsistent with the repo's own exact-money convention and worth tightening in a follow-up pass.
11. **Live keyboard-navigation/screen-reader testing not performed** (section 15).
12. **`/admin/benchmarks` (unrelated, pre-existing) blocks a fully clean end-to-end static export** in any credential-less environment — not fixable without real Supabase credentials, not caused by FDH-8.

## 22. Acceptance Checklist (spec 144-153, itemised)

- [x] No new transaction/categorisation/reconciliation engine created.
- [x] Pending/unapproved transactions never silently enter approved totals — proven with 2 independent negative-control instruments.
- [x] Transfers never inflate income/expense — certified.
- [x] Duplicates never double-count — certified.
- [x] Splits never double-count — certified.
- [x] Refunds match FDH-7 exactly (same function).
- [x] Loan proceeds never become income — certified.
- [x] Investment funding never becomes ordinary expense — certified.
- [x] Cash withdrawals never automatically become consumer expense — certified.
- [x] Different currencies never naively summed — certified, structural.
- [x] Exact money throughout canonical totals (`toMinorUnits`/`sumMoney`, zero `reduce` on raw amounts for any headline total) — one non-canonical display-only exception disclosed (residual 10).
- [x] 1,000+ rows never silently truncate — certified at 1,001 with a real keyset walk.
- [x] Tenant B cannot access Tenant A analytics — certified at the DB/RLS layer with forged-filter and no-app-filter negative controls; **not** certified against a live hosted project (disclosed).
- [x] Financial-data errors never display as $0 — `ResourceErrorState` used throughout, verified by code reading.
- [x] FDH-8 never modifies canonical Input Data — grep-verified, zero touches.
- [x] No forecasting/advice/budgeting scope creep — grep-verified, no advice strings, no forecast/budget code.
- [x] No existing FDH engine regressed — 234/234 FDH-6/FDH-7/R8 scoped tests pass, 2,342/2,360 full-repo tests pass (2 pre-existing DEV-credential-gated failures, unrelated).

## 23. Final Verdict

**CONDITIONAL PASS.** Implementation, local financial-integrity/security certification (via pure-function oracle + real-Postgres PGlite, both with genuine negative controls), and full-repository regression are genuinely, evidentially complete. Live-DEV and production certification are the explicitly-anticipated external steps this session cannot reach (no credentials, no deploy access) — reported precisely as pending, not rounded up to a claim this session did not earn.

## 24. Initial Standalone FDH Status

| Phase | Status |
|---|---|
| FDH-0 | Discovery/architecture-audit PASS |
| FDH-1 | Data foundation FULL PASS |
| FDH-2 | AU/India taxonomy FULL PASS (DEV + production certified) |
| FDH-3 | Secure Document Lifecycle FULL PASS |
| R7/FDH-4 | Bank CSV Engine + adapter coverage FULL PASS, merged to main |
| FDH-5 | Bank PDF Processing FULL PASS |
| R8 | Merchant & Categorisation Intelligence FULL PASS |
| FDH-6 | Economic Classification/Transfers/Refunds/Recurring FULL PASS |
| FDH-7 | Review, Corrections, Splits, Approval FULL PASS |
| **FDH-8** | **CONDITIONAL PASS this session — local + regression complete, DEV/production pending** |

## 25. Financial Data Hub Standalone User Journey

Upload → Secure processing (FDH-3) → CSV/PDF extraction (R7/FDH-4, FDH-5) → Canonical transactions → Reconciliation → Merchant/category intelligence (R8) → Economic classification (FDH-6) → Transfer/duplicate/refund/recurring intelligence (FDH-6) → User review (FDH-7) → User correction (FDH-7) → User approval (FDH-7) → **Financial Activity/Expense Tracker (FDH-8)**. The full chain is functionally complete pending FDH-8's own production release — this journey has never been exercised end-to-end against a live environment in this session (section 16), so "functionally complete" describes the code path, not a live-verified user journey.

## 26. FDH-9 Readiness

**AMBER.** FDH-8's approved activity is stable enough in principle for a future FDH-15 Input Data bridge to consume (recurring income/expenses/category totals/financial activity, per spec 115) without FDH-8 changing — but that mapping was deliberately not built here, and FDH-8 itself has not been DEV/production certified yet. AMBER rather than GREEN specifically because of the disclosed DEV/production gap, not because of any known defect in the code delivered.

## Next Action: STOP.

This report is the terminal deliverable for this session. No FDH-9 work was started, per standing instruction.
