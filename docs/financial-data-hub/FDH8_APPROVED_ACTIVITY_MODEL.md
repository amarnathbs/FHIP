# FDH-8 — Approved Activity Model

## The critical invariant (Product Owner's own emphasis)

> "FDH-7 has finally created a genuine user-approval boundary; FDH-8 must not accidentally undo that by mixing machine-classified but unapproved transactions back into the headline expense/income numbers."

FDH-8 satisfies this by construction, not by convention:

1. `lib/financial-data-hub/analytics/financialActivityAnalytics.ts#fetchScopedTransactions()` takes `approvalStatus: FdhTransactionApprovalStatus` as a **required** parameter and issues `.eq('approval_status', approvalStatus)`. There is no code path in this file that omits that filter.
2. `getOverview()` is the only function that fetches both statuses. It calls `fetchScopedTransactions(..., 'approved', ...)` and `fetchScopedTransactions(..., 'pending', ...)` as two **separate awaited calls**, assigns their results to two **separate local variables** (`approvedTxns` / `pendingTxns`), and never concatenates, spreads, or unions them. Each is passed to its own `computeTotalsByCurrency()` call, producing two separate result arrays: `approved: CurrencyTotals[]` and `pending: PendingDisclosure[]`.
3. Every other analytics function (`getSpendingBreakdown`, `getIncomeBreakdown`, `getTrend`, `getMerchants`, `getAccounts`) calls `fetchScopedTransactions(..., 'approved', ...)` **only** — pending transactions never enter any of those computations at all.
4. `getTransactions()` (the Transaction Explorer) is the one place a caller CAN see pending transactions in a list — by explicit request (`approval_status=pending` filter or no filter at all, to browse everything) — but it is a raw list view, not an aggregate total. It never feeds into `computeApprovedFinancialSummary`.

## Where the number comes from

Every headline total (Income/Expense/Net Cash Flow on Overview, per-category totals on Spending/Income, per-month totals on Trend, per-account totals on Accounts) is produced by calling `computeApprovedFinancialSummary()` from `lib/financial-data-hub/domain/approvedSummary.ts` — **the exact same function** `lib/financial-data-hub/services/approvalService.ts` calls to persist `fdh_approved_financial_summaries` when a user approves a statement. FDH-8 does not define a second meaning for "income", "expense", "transfer", "duplicate", "split", or "refund" anywhere. This is verified by grep: `financialActivityAnalytics.ts` is the only FDH-8 file that imports `approvedSummary.ts`, and `computeApprovedFinancialSummary` is called from exactly four functions in that file (`computeTotalsByCurrency`, used by `getOverview`/`getAccounts`, and directly inside `getTrend`'s per-month loop) — never re-implemented.

## What "pending" means and how it is disclosed

- A transaction is "pending" when `fdh_transactions.approval_status = 'pending'` (FDH-7, migration 0076) — i.e. the user has not taken the deliberate approval action, regardless of whether it has also been machine-classified, is `review_status = 'not_required'`, or looks clean.
- `OverviewResult.pending` is an array of `PendingDisclosure` (one entry per currency present among the user's pending transactions in the selected period): `{ currency_code, transaction_count, income_total, expense_total, net_amount }`. It is **only ever present as a distinct field** — the UI layer renders it as a separate, explicitly-labelled card/line (see `FDH8_OVERVIEW_UX.md`), modelled directly on spec 12's own example: "Approved spending: $4,250" + "Pending review: $180", never "$4,430".
- When there is no pending activity in the selected period, `pending` is an empty array (never a zero-filled placeholder that could be mistaken for "no pending exists at all" vs "not computed").

## Negative control (this is the proof, not just the design)

`tests/unit/fdh8FinancialIntegrityCertification.test.ts`, describe block `*** FDH-8 CRITICAL SCENARIO — Pending Review ***`, plus `scripts/fdh8_certification.mjs` SECTION 1, both:

1. Compute the CORRECT separated totals and assert the approved total is untouched by the existence of a pending transaction.
2. Deliberately perform the WRONG merge (concatenate approved + pending, or drop the `approval_status` filter at the SQL layer) and assert that this wrong computation produces the exact forbidden number the PO described ($4,430 from $4,250 approved + $180 pending) — proving the correct code path's output is provably different from, not coincidentally equal to, the buggy one.

Real run evidence (both commands executed in this session, not simulated):

```
$ npx vitest run tests/unit/fdh8FinancialIntegrityCertification.test.ts
 Test Files  1 passed (1)
      Tests  26 passed (26)

$ node scripts/fdh8_certification.mjs
=== SECTION 1: approved vs pending — the query FDH-8 actually issues ===
  PASS  approved-scoped query returns exactly the $4,250 approved row
  PASS  pending-scoped query returns exactly the $180 pending row
  PASS  the two scoped queries never share a row
  PASS  NEGATIVE CONTROL — dropping approval_status filter WOULD merge pending into the total ($4,430, the exact forbidden number, spec 12)
  PASS  the correctly-scoped approved total ($4,250) differs from the unscoped negative control ($4,430)
=== FDH-8 DB Certification: 12 PASS, 0 FAIL ===
```

## Boundaries this model respects

- **No new approval semantics.** FDH-8 reads `approval_status`; it never writes it. There is no FDH-8 API route that mutates `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, or `fdh_statement_uploads`.
- **No competing pending-detection.** "Pending" is exactly `approval_status = 'pending'` — FDH-8 invents no secondary notion of "not really approved yet".
- **Review counts are separate from approved/pending money totals.** `ReviewCounts` (needs_attention/transfers/possible_duplicates/uncategorised/recurring_candidates) are informational counts reused verbatim from the same queries `review-queue/route.ts` already runs — they are never added to, or subtracted from, any dollar total.
