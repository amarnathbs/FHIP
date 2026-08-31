# FDH-12 — Balance Reconciliation

Spec sections 46-49, 127-128, 142.

## The identity

```
  opening
    + contributions (employer, personal, salary sacrifice, government)
    + rollovers in
    + earnings / interest / distributions
    - rollovers out
    - withdrawals / pension payments
    - fees
    - insurance premiums
    - taxes
    ± adjustments
  = closing
```

Direction comes from `RETIREMENT_ACTIVITY_DIRECTION` in `retirement/types.ts` —
one definition, read by every consumer.

## Exact decimal arithmetic (spec 142)

Every term is an **integer of minor units held as `bigint`**. Money is parsed
from statement TEXT straight to integer minor units by string manipulation
(`retirement/money.ts`); no IEEE-754 value is ever constructed.

`bigint` rather than `number` because `numeric(20,4)` holds 16 integral digits,
which exceeds `Number.MAX_SAFE_INTEGER` once scaled — an overflow that would
silently corrupt a large fund balance. Certified: `99999999999999.99`
round-trips exactly and is confirmed to exceed `MAX_SAFE_INTEGER`.

Negative control in the suite: `0.1 + 0.2 !== 0.3` in float, and 10,000 float
additions of `0.1` do not equal 1000 — while the exact path gives both answers
correctly, at 10,000 rows.

## Tolerance: ZERO

`RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS = 0n`. The named constant
exists so that fact is visible rather than implicit. A tolerance band would be
exactly the "silently round away a material source mismatch" spec section 48
forbids.

### Spec 127 / 128 — the certified scenario

Opening $100,000 + employer $8,000 + personal $2,000 + earnings $5,000
− fees $500 − tax $1,000 = closing **$113,500** → **RECONCILED**.

Move ANY single figure by $0.01 → **VARIANCE**, with the exact signed variance
reported. Certified for the closing balance, the opening balance, and an
individual activity, and re-certified at 10,000 activities.

## INSUFFICIENT_DATA is a first-class answer (spec 47, 49)

Returned when:

* the statement gives a closing balance but **no opening balance** — completely
  normal for a first member statement. FDH-12 does **not** invent an opening of
  0; doing so would fabricate a VARIANCE equal to the whole account. The
  closing balance remains perfectly good evidence and still drives the
  proposal.
* both balances but no movement detail.
* any row could not be classified (`UNKNOWN`) or its amount could not be read.
  Reporting RECONCILED there would be a false pass; reporting VARIANCE would
  blame the fund for our own gap.

## Two evidence paths, never combined (spec 118)

Line detail and printed period totals are **alternative** evidence for the same
movement. `reconcileStatement()` picks one — line detail when usable, printed
totals otherwise — and never sums both. It also does not shop between them
looking for a RECONCILED: activity detail that genuinely does not balance
reports VARIANCE even when the contradictory printed totals would reconcile.

## Subtotal and YTD exclusion

Rows flagged `is_summary_total` or `is_year_to_date` are filtered out before
summing. This is the single most important line in the module: an annual
statement printing a 12,000 total above twelve 1,000 lines would otherwise
reconcile to 24,000.

## Current vs statement (spec 55)

A separate DISPLAY comparison — "what would change if I applied this?" — not a
reconciliation. Returns Current / Statement / Difference, flags an identical
balance, and returns a **null** difference (never a fake $0) when either side
is absent.
