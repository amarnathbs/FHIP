# FDH-8 — Information Architecture

## Navigation

One additive entry in `components/ui/AppShell.tsx#NAV_GROUPS` — "Financial Activity" (or the label the UI build settled on; see the completion report for the exact final label and group placement), pointing at `/financial-data-hub/activity`. No existing nav group, label, or route is restructured.

## Route tree

```
app/(app)/financial-data-hub/
  page.tsx                    (EXISTING — FDH-3 upload UI, unmodified)
  activity/
    layout.tsx                 (shared sub-nav + period selector)
    page.tsx                   Overview
    transactions/page.tsx      Transaction Explorer
    spending/page.tsx          Spending
    income/page.tsx            Income
    recurring/page.tsx         Recurring
    accounts/page.tsx          Accounts
```

This matches spec section 8's recommended primary navigation (Overview / Transactions / Spending / Income / Recurring / Accounts / Review) with one deliberate deviation: no separate "Review" sub-page is built — every "needs review" surface (Overview's review status card, Transaction Explorer's per-row review link) routes directly into the EXISTING FDH-7 review experience rather than duplicating it under a seventh FDH-8 tab, per spec 13's explicit instruction ("do not recreate the review engine") and spec 57's ("without building a second review drawer").

## API surface

All eight routes live under `app/api/financial-data-hub/activity/` (`overview`, `transactions`, `spending`, `income`, `trend`, `merchants`, `recurring`, `accounts`), each a thin `GET` handler: `requireUser()` → `parseActivityParams()` → one call into `lib/financial-data-hub/analytics/financialActivityAnalytics.ts` → `ok(...)`/`bad(...)`. No route contains aggregation logic of its own.

## Data flow

```
UI page/component
  -> (server-side) financialActivityAnalytics.ts function
      -> fetchScopedTransactions()  [fdh_transactions + fdh_transaction_allocations, RLS-scoped]
      -> fetchConfirmedRefundLinks() [fdh_transaction_links]
      -> computeApprovedFinancialSummary()  [lib/financial-data-hub/domain/approvedSummary.ts — FDH-7's own oracle]
  -> typed result object
  -> page renders (SectionCard/Stat/charts.tsx/ResourceStates)
```

No client-side aggregation of raw transaction rows for any headline total — the Transaction Explorer is the only page that ships row-level data to the browser, and only for direct display (a table), never client-side summed into a total.
