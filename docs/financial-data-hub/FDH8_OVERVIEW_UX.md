# FDH-8 — Overview UX

## Primary cards (spec 14)

Income / Expenses / Net Cash Flow / Transaction count, sourced from `OverviewResult.approved` (one `CurrencyTotals` per currency present). Net Cash Flow is rendered as `income_total - expense_total`, never `all credits - all debits` (spec 15) — this is `net_cash_flow`, already computed server-side via `sumMoney`.

## The approved/pending disclosure (THE critical UI requirement)

Rendered exactly per spec 12's own example shape:
- "Approved spending: `formatMoney(expense_total, currency)`" — always shown, even when $0 (with an explicit "$0 approved" rather than omitting the card, so a genuinely-zero month is never confused with a loading/error state).
- Only when `OverviewResult.pending` contains a nonzero entry for that currency: a visually distinct, separately-labelled line/card — "N transactions — `formatMoney(pending_total, currency)` waiting for review" — with a "Review transactions" link into the existing FDH-7 review surface. This line is never combined into the approved figure above it, never rendered as a plain addition, and disappears entirely (not a "$0 pending" placeholder) when there is nothing pending.

## Secondary cards (spec 14)

Largest spending category (`largestCategory`), recurring expenses count (`recurringActiveCount`), and the review status card (spec 13): "N transactions need your review" / "N possible transfers" / "N uncategorised" / "N recurring candidates", each from `OverviewResult.review`, with one "Review transactions" CTA into the existing FDH-7 review UI. No dozens-of-cards overload (spec 14) — this is 4 primary + up to 3 secondary + the review card + the pending disclosure, matching the spec's own restraint instruction.

## Freshness (spec 59)

"Latest activity: `freshness.latestTransactionDate`" — the newest `transaction_date` the user has, NEVER labelled from `lastStatementProcessedAt` (an upload/processing timestamp, shown separately and distinctly worded, e.g. "Last statement processed: ...").

## Empty/partial states (spec 60-63)

- No accounts/no transactions at all: empty state with an upload CTA reusing the existing FDH-3 upload flow (`/financial-data-hub`) — no second uploader built.
- Transactions exist but `approved` is empty while `pending` is not: "Your transactions are ready to review" with a CTA into FDH-7 — never rendered as "$0 approved spending" (spec 63's explicit example).
- A component-level fetch failure (e.g. merchants call fails) does not blank the whole page — each section owns its own loading/error boundary via `ResourceLoadingSkeleton`/`ResourceErrorState`, so a working Overview total is never hidden behind an unrelated failed request (spec 109).

See the completion report's UX & Accessibility section for the actual file paths and pass/fail evidence from the UI build pass.
