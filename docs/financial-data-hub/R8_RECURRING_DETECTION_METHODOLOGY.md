# R8 — Recurring/Subscription Detection Methodology

## 1. False-recurrence protection (spec section 52) — the core guard

Grouping by merchant/description is not enough on its own; five random
supermarket trips in a month are not a subscription. `detectRecurringSeries()`
(`lib/financial-data-hub/classification/recurringDetection.ts`) additionally
requires that **every consecutive gap between occurrences lands in the SAME
canonical frequency bucket**:

| Frequency | Nominal days | Tolerance |
|---|---|---|
| weekly | 7 | ±2 |
| fortnightly | 14 | ±3 |
| monthly | 30 | ±5 |
| quarterly | 91 | ±10 |
| annual | 365 | ±15 |

A single inconsistent gap disqualifies the whole candidate group — proven
by `tests/unit/r8TransferRefundRecurring.test.ts`'s "repeated same-merchant
purchases with random gaps produce NO series" negative control.

## 2. Grouping key

`(financial_account_id, merchant_id ?? normalised description, credit_debit)`
— never mixes credit and debit direction into one series (a salary credit
and an unrelated debit at the same merchant-adjacent description are never
folded together), and groups by normalised (upper-cased, trimmed)
description when no `merchant_id` is available yet.

## 3. Date drift (spec section 50)

The tolerance bands above absorb realistic weekend/month-boundary drift —
a "1st of the month" direct debit landing on the 2nd or the 30th of the
prior month is still detected as monthly. Tested directly
(`'handles realistic weekend/month-boundary date drift within tolerance'`).

## 4. Amount variation (spec section 51)

Both fixed (Netflix: $15.99 every time) and variable (an energy bill:
$98–$145) series are supported without requiring exact equality —
`amountTolerance` records the observed spread. Confidence is HIGH only when
the spread is tight (≤1% of the mean, or a single-cent rounding gap) AND
history is sufficient; a wide spread stays MEDIUM even with 3+ occurrences.

## 5. Series status (spec section 53)

| DB `status` | Spec concept | How it's reached |
|---|---|---|
| `candidate` | INSUFFICIENT_HISTORY | Detected with only 2 occurrences |
| `active` | ACTIVE | 3+ occurrences, all matching one frequency bucket |
| `paused` | POSSIBLY_PAUSED | `refreshSeriesStatus()`: more than 1.5× the nominal period has passed with no new matching occurrence |
| `ended` | ENDED | **Never set automatically.** Only a user's explicit review action (`POST /recurring-transactions/{id}/review`, decision `end`) sets this — "do not declare cancellation after one missing occurrence" (spec section 53) is enforced by construction: no code path in this release ever writes `status='ended'` except the user-review service. |

## 6. Membership persistence

Migration 0067 adds `fdh_transactions.recurring_transaction_id` (nullable
FK) — the one genuinely new column this release needed for recurring
detection, since FDH-1's `fdh_recurring_transactions` table had no
member-linkage mechanism at all. A transaction belongs to at most one
series; if evidence ever supported two candidate series the detection
algorithm's own grouping (one group per `(account, merchant/description,
direction)` key) structurally prevents that ambiguity from arising in the
first place — a transaction can only ever appear in one group.

## 7. Disclosed residuals

- No UI for the recurring-series review queue (API-only).
- `refreshSeriesStatus()` is a pure function; nothing in this release wires
  it to a scheduled job that re-evaluates existing ACTIVE series as time
  passes (a following release's concern — the detection pass itself is
  idempotent and safe to re-run at any time, which is the mitigation for
  this gap today).
