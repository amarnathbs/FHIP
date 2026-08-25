# FDH-8 — Merchant Experience

`getMerchants(userId, filters, { limit })` — approved, expense-only, duplicate-excluded, allocation-aware merchant ranking. Rendered on the Spending page (`spending/page.tsx`, "Top merchants" table, limit 10) as a semantic `<table>` with merchant/total spent/transaction count/average/last transaction columns (spec 29-30).

## What counts as a merchant total

A row contributes to a merchant's total only when it (or, for a split transaction, one of its allocations) is classified `economic_transaction_type = 'expense'` AND carries a `merchant_id`. Concretely excluded by this rule (spec 31):
- Own-account transfer counterparties — `transfer` rows are never `expense`, so they never reach a merchant bucket, and transfer counterparties typically carry no `merchant_id` at all (a personal transfer recipient is not global merchant-master data, per spec 29's own distinction).
- Loan drawdowns, investment funding, ATM withdrawals — none of these are `economic_transaction_type = 'expense'` (they are `debt_principal`/`investment`/`cash_withdrawal` respectively), so none reach the merchant ranking.
- Confirmed duplicates — `dedup_status` excluded exactly as everywhere else in FDH-8.

## What a merchant total does NOT do

Refund netting is NOT applied at merchant granularity — a refund transaction is `economic_transaction_type = 'refund'`, never `'expense'`, so it is invisible to `getMerchants()` regardless of which merchant it relates to. This is a disclosed, deliberate simplification (documented in the analytics file's own header comment): FDH-7's refund-netting is defined at the OVERALL expense_total level, not per-merchant, and FDH-8 does not invent a per-merchant refund-netting rule of its own rather than risk it disagreeing with a future certified definition. A merchant's "Total spent" can therefore be marginally higher than a hypothetical refund-aware figure if that merchant issued refunds in the period — an Open Residual, not a financial-integrity defect (nothing is double-counted or misclassified; it is a scope-of-netting choice, disclosed).

## Ranking

Sorted descending by `totalSpent` (exact money, minor-unit accumulated), per currency — the same "no naive currency addition" rule as every other FDH-8 aggregate (a merchant with both AUD and INR spend gets two separate rows, one per currency, never blended).
