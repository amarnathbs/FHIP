# FDH-10 — Loan Intelligence

## The headline control (spec section 5)

A $2,000 loan payment disclosed as $1,550 principal + $430 interest + $20 fee must decompose to **exactly** $1,550 liability reduction + $450 expense + $2,000 cash outflow — never $2,450 (double count), never $2,000 flat expense. `lib/financial-data-hub/liability/repaymentDecomposition.ts`'s `decomposeLoanPayment()` is the single function responsible; `tests/unit/fdh10LoanRepaymentDecomposition.test.ts` certifies the exact worked example plus a reintroduced-defect RED/GREEN pair (a dropped fee component making the components sum to $1,980 instead of $2,000 is detected as `component_mismatch`, not silently accepted).

## Loan drawdown is not income (spec section 30)

`classifyLoanAdvance()` can only ever return `economicType: 'transfer'` — `'income'` is not a member of its return type's literal union at all, so this is a compile-time guarantee, not merely a runtime check. `incomeContribution` is typed as the literal `0`.

## AU mortgage / India EMI (spec sections 15, 34)

`decomposeLoanPayment()` **only ever uses statement-disclosed components** — it has no amortisation formula and never approximates principal from rate/balance. This directly satisfies spec section 34's precedence rule ("statement-provided split takes precedence... unless a certified amortisation engine already owns that calculation" — none does, so nothing is approximated). A statement with an incomplete disclosure returns `insufficient_evidence`, not a guess.

## Balance reconciliation (spec section 38)

`statementReconciliation.ts`'s `reconcileLoanStatement()` implements:

```
opening principal + drawdowns + capitalised items (if evidenced)
  − principal repayments ± adjustments = closing principal
```

Interest has **no input slot in this formula at all** — a structural guarantee that ordinary interest can never alter the principal roll-forward (spec 38's "interest generally must not alter principal unless capitalised and explicitly evidenced"). The 0.01 negative control (`tests/unit/fdh10StatementReconciliation.test.ts`) proves a one-cent discrepancy in `principalRepaymentsTotal` flips a reconciled statement to `variance`.

## Facility types and rate handling (spec sections 12, 77)

8 facility types supported (`credit_card`, `personal_loan`, `home_loan`, `investment_property_loan`, `vehicle_loan`, `other_term_loan`, `line_of_credit`, `overdraft`). `liabilityAdapter.ts` proposes `interest_rate` **only for loan facilities, never for credit cards** — the adapter's own `buildProposal` guards this with an explicit `!isCreditCard` check, so a card's purchase/cash-advance APR can never overwrite a canonical loan rate by construction.

## AU offset accounts, redraw (spec section 84)

Audited: no existing canonical logic recognises an offset relationship between a savings account and a mortgage anywhere in the current schema. FDH-10 therefore implements none — no netting of any account against a mortgage balance is performed anywhere in this codebase, matching the spec's explicit instruction not to build this without existing canonical support.

## What is NOT implemented in this pass

Per-institution EMI/mortgage statement parsing, arrears-status extraction beyond a bare evidence field, and rate-change-mid-period tracking are not implemented — the decomposition and reconciliation LOGIC is complete and independently certified (18 tests across the two files above).
