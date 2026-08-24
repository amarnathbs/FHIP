# FDH-7 — Recurring & Refund Review

FDH-6 owns recurring/refund detection; FDH-7 owns nothing new here.

## Recurring (spec 41-42), pre-existing

`POST /api/financial-data-hub/recurring-transactions/{id}/review` (R8) with `{ decision: 'confirm' | 'pause' | 'resume' | 'end' }`, transitions enforced by `ALLOWED_SERIES_TRANSITIONS` in `classificationReviewService.ts` AND by the DB trigger (`fdh_recurring_transactions`, migration 0068). No "Recurring = subscription" language exists anywhere in this code path — `frequency`/`next_expected_date` are the only surfaced facts; `fdh_merchants.recurring_type` (FDH-2, separate table) is the only place a subscription-like label lives, and it is merchant-level likelihood metadata, never asserted about a specific transaction.

## Refund (spec 43), pre-existing

Confirm/reject is the SAME `transaction-links/{linkId}/review` endpoint used for transfers — `link_type IN ('refund_original', 'reversal_original')` is just another value of the same generic relationship table. A confirmed refund never becomes income merely because it is a credit: its `economic_transaction_type` stays `'refund'` (a value distinct from `'income'` in the frozen FDH-1 taxonomy), and only nets against the ORIGINAL expense's total in the Approved Financial Summary (spec 60) — see `FDH7_APPROVED_FINANCIAL_SUMMARY.md`.

## No forecasting (spec 41)

FDH-7 adds no cadence prediction, no "next charge" UI logic, no subscription-cost rollup — those belong to FDH-8.
