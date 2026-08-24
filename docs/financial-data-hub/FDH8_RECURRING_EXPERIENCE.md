# FDH-8 — Recurring Experience

`getRecurring(userId)` reads `fdh_recurring_transactions` directly (status `active|candidate|paused`, ordered by status) and joins each row's `merchant_id` against the merchant master for a display name. **Zero detection logic** — no `frontendRecurringDetector()` exists anywhere in FDH-8 (grep-verified), matching spec 40's explicit prohibition. FDH-6/R8 determine recurrence; FDH-8 only displays `fdh_recurring_transactions` rows as they already exist.

## Fields shown (spec 40)

Merchant/payee (`merchantDisplayName`, from R8's merchant master — `null` when the series has no merchant), typical amount (`expectedAmount`/`currencyCode`), cadence (`frequency`: weekly/fortnightly/monthly/quarterly/annual/irregular — the exact FDH-6 vocabulary, no new cadence values invented), status (`active|candidate|paused|ended` — the exact FDH-6 vocabulary), and `nextExpectedDate` **only when the certified engine itself populated it** (`fdh_recurring_transactions.next_expected_date`, nullable) — FDH-8 never computes or fabricates a next-expected date of its own; a `null` is rendered as "not yet estimated", never as a guessed date.

## Differentiation (spec 40)

Subscription vs recurring bill vs recurring income vs loan repayment vs other recurring: the underlying schema does not carry a first-class "recurring kind" enum (`fdh_recurring_transactions` has `frequency`/`status`/`merchant_id`/`expected_amount` only) — FDH-8 derives a display label from the linked merchant's `merchant_type`/category `economic_type` where available (e.g. a series whose merchant has `merchant_type` indicating a subscription service, or whose category `economic_type = 'debt_principal'`, is labelled accordingly), and falls back to a generic "Recurring" label rather than guessing. This derivation lives in the UI layer, not in `getRecurring()` itself, so it never becomes a second classification engine — see the completion report for the UI build's exact implementation.

## "ended" series excluded

`getRecurring()` filters to `active|candidate|paused` only — `ended` series are not shown by default (there is no ongoing recurring activity to review), consistent with this being a "what's recurring now" view, not a historical archive.
