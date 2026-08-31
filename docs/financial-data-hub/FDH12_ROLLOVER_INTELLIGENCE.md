# FDH-12 — Rollover Intelligence

Spec sections 33-35, 122, 149. **The highest-risk retirement rule.**

```
  Old fund  -$100,000
  New fund  +$100,000
  ------------------------------------------
  CORRECT:   a ROLLOVER / TRANSFER
  FORBIDDEN: income  $100,000
  FORBIDDEN: expense $100,000
  FORBIDDEN: household net worth +$100,000
```

## Why each forbidden outcome is unreachable

**Income / expense.** FDH-12 has no write path to `income_sources`, to any
expense register, or to `fdh_transactions`. No function, no allow-list entry,
no column. Asserted mechanically over the real source tree by
`tests/unit/fdh12FinancialIntegrity.test.ts` and `fdh12Isolation.test.ts`.
Both rollover legs are additionally marked INTERNAL, so bank matching returns
`not_expected` and never even looks for a cash event — proven with a test in
which a perfectly matching bank row exists and is still not matched.

**Net worth +$100,000.** Net worth is `Σ retirement_accounts.current_balance`
(`lib/engines/dashboard.ts:582`) and nothing else. A rollover changes which
account holds the money; applying both statements ASSIGNS each fund its own
closing balance. The sum is unchanged because balances are assigned, never
incremented.

## Spec 34 — the double-count control

| | Fund A | Fund B | Household |
| --- | --- | --- | --- |
| Before | $100,000 | $0 | **$100,000** |
| After | $0 | $100,000 | **$100,000** |
| Forbidden | | | $200,000 |

`householdRetirementTotalMinorUnits()` exists specifically so the harness can
assert this directly rather than against prose.

The $200,000 state cannot arise from applying — only from *failing to apply*
Fund A's statement while applying Fund B's. That is a user-visible state (Fund
A still shows its old balance), and pairing the two legs is what makes the UI
able to prompt for both sides.

## Spec 35 — partial rollovers

Fund A $150,000, rolls out $50,000; Fund B receives $50,000 →
A $100,000, B $50,000, total **$150,000**. Nothing special is required: each
statement's own closing balance is the proposed value.

## Pairing rules

Opposite direction, **exactly equal** amount, same currency, **different**
canonical account, different statement, within 30 days.

* The different-account requirement stops a fund's own internal switch (which
  some statements report as a paired out/in) being read as an inter-fund
  rollover.
* Exact equality, no tolerance — a partial rollover has equal legs too.
* More than one plausible counterpart → `multiple_candidates`, never a guess.
* No counterpart → `no_match` with reason `counterpart_statement_not_available`.
  This is **not an error**: the user may simply not have uploaded the other
  fund's statement, and it is never a reason to reclassify the activity.

## UX (spec 149)

The review table labels the legs **"Transfer in (rollover)"** and
**"Transfer out (rollover)"** — never "income" — with the explanatory notes
"Moved in from another retirement account — not new money" and "Moved out to
another retirement account — not spending."
