# FDH-8 — Spending Experience

`getSpendingBreakdown(userId, filters)` = `computeCategoryBreakdown(..., 'expense')`. Total approved spending, per-category rows (`displayName`, `essentialDiscretionary`, `total`, `percentage`, `transactionCount`), sorted descending, plus `uncategorisedTotal` shown separately as "Needs categorisation: $X" (spec 56's explicit requirement) rather than folded into any category row.

## Category = R8 master data, no new taxonomy (spec 25-26)

Every row's `displayName`/`essentialDiscretionary` comes straight from `fdh_categories` (via `categoriesRepository.listActiveAll()`); FDH-8 defines no category of its own.

## Percentage (spec 56)

`percentage = category.total / categorisedTotal * 100`, rounded to one decimal, where `categorisedTotal` excludes the `'uncategorised'` bucket — so percentages always sum to ~100% across the categorised rows shown, and never silently include the unclassified amount in the denominator (which would understate every category's true share once uncategorised spend exists).

## Essential vs discretionary (spec 27)

Read directly off each category's `essentialDiscretionary` field (one of `essential|discretionary|mixed|user_dependent|not_applicable`) — FDH-8 performs no inference and does not force `mixed`/`user_dependent` into either bucket; a page summarizing "essential vs discretionary" totals must sum only rows where `essentialDiscretionary === 'essential'` or `'discretionary'` and show `mixed`/`user_dependent`/`not_applicable` as their own explicit group (or omitted with disclosure), never silently absorbed.

## Top merchants on the Spending page (spec 29-31)

`spending/page.tsx` also renders a "Top merchants" table from `getMerchants()` (limit 10, ranked by approved expense magnitude, excluding transfers/loan drawdowns/investment funding/ATM withdrawals by construction — see `FDH8_MERCHANT_EXPERIENCE.md`). Fetched as an independent, best-effort call: a merchants-query failure renders `ResourceErrorState` for that section only and does not blank the already-successful category breakdown above it (spec 109).

## Category drill-down (spec 28)

Category → Transactions is `getTransactions({ categoryId, period })`; no subcategory-level breakdown function was added in this pass (category-level only) — Open Residual, straightforward to add by grouping on `subcategory_id` the same way.

## Disclosed limitation

See `FDH8_REUSE_AND_GAP_AUDIT.md`'s "Disclosed limitation inherited from the FDH-7 oracle" — the `'uncategorised'` bucket combines all non-transfer economic types, so if both an uncategorised expense and an uncategorised income exist in the same period, "Needs categorisation" on the Spending page and the Income page would show the SAME combined figure rather than two independently-correct ones. Inherited from FDH-7's certified oracle, not introduced by FDH-8, and disclosed rather than silently accepted.
