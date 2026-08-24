# FDH-6 — Recurring Intelligence

Fully owned by R8 (`lib/financial-data-hub/classification/recurringDetection.ts`), unmodified by FDH-6 except for threshold centralisation (values unchanged — cadence buckets, minimum-occurrence and tight-amount-ratio constants moved to `thresholds.ts` verbatim).

## Pattern, not economic class (spec section 39)

`recurring_flag`/`recurring_transaction_id` are independent of `economic_transaction_type` — a recurring series can be `expense` (Netflix), `income` (salary), `fee`, `debt_interest`, or any other class. FDH-6 does not conflate them.

## False-recurrence protection (spec section 40)

Grouping key = `financial_account_id | (merchant_id or normalised description) | credit_debit` — never amount alone, never direction-mixed. Every consecutive gap between occurrences must land in the SAME cadence bucket (weekly/fortnightly/monthly/quarterly/annual, each with its own tolerance window); a single inconsistent gap disqualifies the WHOLE group rather than silently dropping the outlier or reporting a partial series.

## Cadence tolerances (`thresholds.ts`, values unchanged from R8)

| Frequency | Nominal days | Tolerance |
|---|---|---|
| weekly | 7 | ±2 |
| fortnightly | 14 | ±3 |
| monthly | 30 | ±5 |
| quarterly | 91 | ±10 |
| annual | 365 | ±15 |

## Variable amounts (spec sections 42-44)

Salary (overtime/bonus variance), utility bills (genuinely variable monthly amounts) are supported without requiring exact equality — the series records `expectedAmount` (mean) and `amountTolerance` (observed spread) rather than a fixed value. A tight spread (≤1% of the mean, or one cent) plus 3+ occurrences earns HIGH confidence; anything wider earns MEDIUM — confidence is never HIGH merely because occurrences repeated.

## Negative controls (spec section 75), all proven in the certification pack

- `[R-09]` a single occurrence never becomes a series.
- `[R-10]` two payments to a DIFFERENT merchant, same amount → never grouped (different grouping key entirely).
- `[R-11]` genuinely irregular one-off transactions (random gaps) → never forced into a series.
- `[R-08]` a missed month (gap far outside any cadence bucket's tolerance) breaks the series rather than being silently bridged.
- `[R-14]` credit and debit at the same merchant are never mixed into one series.

## INSUFFICIENT_HISTORY (spec section 53)

Fewer than `RECURRING_THRESHOLDS.MIN_OCCURRENCES_FOR_ESTABLISHED` (3) occurrences is still real evidence — the series is proposed but flagged `insufficientHistory: true` / DB `status = 'candidate'`, never silently promoted to an established, confidently-active pattern.

## Never auto-ends

`refreshSeriesStatus()` moves an overdue series to `paused` (>1.5 cadence cycles overdue) but NEVER returns `ended` automatically — only a human, or a much longer disclosed absence in a later phase, may declare a series ended (spec section 53).
