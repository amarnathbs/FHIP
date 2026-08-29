# FDH-10 — Repayment Decomposition

## Storage mechanism: reuse, not a new table

Decomposition is expressed as `fdh_transaction_allocations` rows against the canonical `fdh_transactions` row for the bank debit — the identical split-transaction mechanism FDH-1 built (migration 0047) for splitting one supermarket debit into groceries/household-goods/gift. FDH-10 introduces no new "decomposition" table; `fdh_liability_statement_activities.principal_component`/`interest_component`/`fee_component` exist only to carry the STATEMENT'S OWN disclosed evidence forward from extraction to the point the allocations are written — they are not a second source of truth.

## Function: `decomposeLoanPayment()`

Input: `{ totalPayment, principalComponent?, interestComponent?, feeComponent?, currencyCode }` (each component `undefined` means "not disclosed", never coerced to 0 unless at least one sibling component is known).

Output: one of three outcomes —

1. **`decomposed`** — components sum exactly (zero-tolerance, exact minor-unit comparison via `moneyEquals`) to `totalPayment`. Returns `allocations` (principal/interest/fee, each only included if > 0), `expenseTotal` (interest + fee), `liabilityReductionTotal` (principal).
2. **`component_mismatch`** — components were disclosed but do not sum to the payment (a statement internal-consistency failure, e.g. a fee line the extraction missed). No allocation is produced; the caller routes this to human review rather than guessing.
3. **`insufficient_evidence`** — no components disclosed at all. **The full payment is never defaulted to expense** even in this case (spec section 5's forbidden outcome applies regardless of evidence completeness) — `expenseTotal`/`liabilityReductionTotal` are both `null`.

## Worked certification example (spec section 5, reproduced exactly)

```
totalPayment: 2000, principalComponent: 1550, interestComponent: 430, feeComponent: 20
-> outcome: 'decomposed'
-> liabilityReductionTotal: 1550
-> expenseTotal: 450        (430 + 20 — principal excluded)
-> 450 + 1550 = 2000        (never 2450, never 2000-flat)
```

Verified in `tests/unit/fdh10LoanRepaymentDecomposition.test.ts`, plus: interest-only payments (100% expense, $0 liability reduction), EMI-style principal+interest with no fee line, an interest-heavy payment where principal is small (liability reduction stays exactly at the disclosed principal, never inflated by the interest figure), and a 0.01 mismatch genuinely detected.

## Where decomposition connects to bank matching

`bankMatching.ts` identifies WHICH existing `fdh_transactions` row is the $2,000 cash event; `decomposeLoanPayment()` decides HOW to split it. The two are deliberately independent functions — a statement can be economically decomposed before a bank match exists (producing `insufficient_evidence`-safe evidence), and a bank match can succeed before decomposition evidence is available (in which case the matched transaction's `economic_transaction_type` stays whatever the bank-import classified it as, until decomposition evidence arrives).

## Residual

No service in this pass actually WRITES the `fdh_transaction_allocations` rows from a `decomposeLoanPayment()` result against a live matched transaction — the function is complete, certified, and ready to be called by that service, but the calling code (an API route or background job) was not built this pass.
