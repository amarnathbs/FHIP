# FDH-8 — Income Experience

`getIncomeBreakdown(userId, filters)` = `computeCategoryBreakdown(..., 'income')` — the same function as Spending, filtered to `economic_type === 'income'` categories. Total approved income, per-category rows, `uncategorisedTotal` shown separately.

## Economic INCOME only, never every credit (spec 32-36)

Because the underlying rows come from `computeApprovedFinancialSummary`'s `income_total`/`category_totals` (bucketed strictly by `economic_transaction_type === 'income'`), the three mandatory regression cases are structural, not page-level logic:

- **Loan proceeds must not appear as income** — a loan drawdown is never classified `economic_transaction_type = 'income'` by FDH-6 (it lands in `debt_principal`/`investment`/`unknown` depending on context); `getIncomeBreakdown` only ever reads the `income` bucket, so it cannot appear regardless of classification, and the negative-control test in `fdh8FinancialIntegrityCertification.test.ts` ("Loan proceeds") proves a $25,000 drawdown leaves `income_total` unchanged.
- **Refunds must not appear as normal income** — refunds are `economic_transaction_type = 'refund'`, a distinct bucket from `income`; certified in the "Refund matches FDH-7 exactly" scenario.
- **Own-account transfer credits must not appear as income** — `transfer` is its own bucket, never `income`; certified in the "Transfer" scenario.

## Income groupings (spec 32-36)

Salary/wages, Interest, Dividends, Rental, Business income, Government payments, Other income — these map onto whichever `fdh_categories` rows have `economic_type = 'income'` in the R8 master data; FDH-8 introduces no new grouping labels, it renders whatever category display names R8 already seeded.

## Disclosed limitation

Same combined-`'uncategorised'`-bucket caveat as `FDH8_SPENDING_EXPERIENCE.md` — see that document and `FDH8_REUSE_AND_GAP_AUDIT.md`.
