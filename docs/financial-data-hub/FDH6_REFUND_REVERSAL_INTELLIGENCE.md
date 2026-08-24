# FDH-6 — Refund/Reversal Intelligence

Fully owned by R8 (`lib/financial-data-hub/classification/refundReversalMatching.ts`), unmodified by FDH-6 except for threshold centralisation (values unchanged).

## Two separate jobs, kept separate

1. **"Is this transaction a refund?"** — an economic-classification decision, made by `economicTypeEngine.ts` from FDH-2's seeded narrative-pattern rules (`refund_purchase_generic`, `refund_reversal_generic`, `refund_reversed_generic`, `refund_chargeback_generic`).
2. **"Which original transaction does this refund undo?"** — a LINKING decision, made by `refundReversalMatching.ts`, only among transactions ALREADY classified `refund` by job 1.

## Matching evidence (unchanged, R8)

Same account, opposite direction, same currency, refund amount ≤ original (never exceeds — spec section 36), refund dated on/after the original, within `REFUND_THRESHOLDS.LOOKBACK_DAYS` (90 days). Closest-in-time/closest-in-amount wins; an unmatched refund stays unlinked (persistent missing-original pattern), never fabricated.

## Partial refunds (spec section 37)

`amountDelta === 0` → `link_type = 'refund_original'`, full confidence (1.0) when also within 7 days. `amountDelta > 0` (refund smaller than the original) → `link_type = 'reversal_original'`, confidence 0.6. Refund amount is never required to equal the original.

## Negative controls (spec section 76), all proven in the certification pack

- `[F-03]` same amount, different account/merchant → never linked.
- `[F-04]` salary 1000 credit is never a "refund" of a prior 1000 expense, because it was never classified `refund` by job 1 in the first place — job 2 only ever considers rows job 1 already flagged.
- `[F-06]` a refund larger than its candidate original → never linked.
- `[F-07]` a refund dated before any candidate original → never linked.
- `[F-08]` a refund outside the 90-day lookback → never linked.
- `[F-05]` the genuine positive case (verified reversal, matching evidence) IS linked.

## REFUND vs REVERSAL vs CHARGEBACK

The schema's `link_type` distinguishes `refund_original` (exact amount) from `reversal_original` (partial); FDH-2's rule seed separately distinguishes the CLASSIFICATION narrative (`refund_reversal_generic`/`refund_reversed_generic` for `"REVERSAL"`/`"REVERSED"` narratives, `refund_chargeback_generic` for `"CHARGEBACK"`) — real, disclosed distinctions drawn from actual bank narrative vocabulary, never fabricated (spec section 38).
