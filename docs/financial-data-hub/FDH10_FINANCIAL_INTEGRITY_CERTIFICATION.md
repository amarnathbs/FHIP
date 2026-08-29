# FDH-10 — Financial Integrity Certification

## The two headline controls (spec section 154) — both certified with RED/GREEN negative controls

### 1. Card purchase + bank repayment = ONE expense, never two

`tests/unit/fdh10CreditCardEconomics.test.ts`:
- GREEN: $200 purchase + matched $200 repayment -> $200 total expense.
- RED (reintroduced defect): bank-side misclassification of the repayment as `expense` -> $400 detected and flagged as wrong by `assertNoDoubleCount()`.
- GREEN (restored): correct `transfer` classification -> $200 again.
- Structural: `classifyStatementActivity('PAYMENT')` can never return `'expense'`.

### 2. Loan payment = principal reduction + interest/fee expense, never full-payment-as-expense

`tests/unit/fdh10LoanRepaymentDecomposition.test.ts`:
- GREEN: $2,000/$1,550/$430/$20 -> $1,550 liability reduction + $450 expense (never $2,450, never $2,000 flat).
- RED (reintroduced defect): dropped fee component -> `component_mismatch`, not silently accepted.
- GREEN (restored): correct components -> decomposes cleanly again.

## Mandatory negative-control checklist (spec sections 98-106)

| Control | Status | Evidence |
|---|---|---|
| loan-drawdown-as-income | PASS | `classifyLoanAdvance()` — type-level guarantee + runtime test |
| principal-as-expense | PASS | `decomposeLoanPayment()` excludes principal from `expenseTotal` in every code path |
| interest-as-principal | PASS | Interest-heavy-payment test: liability reduction stays exactly at the disclosed principal |
| card-repayment-double-count | PASS | Headline control 1 above |
| loan-payment-decomposition | PASS | Headline control 2 above |
| statement-balance-0.01-variance-detection | PASS | Both card and loan reconciliation formulas, `fdh10StatementReconciliation.test.ts` |
| bank-match-wrong-facility-same-amount | PASS | `fdh10BankMatching.test.ts` |
| duplicate-document | PARTIAL | Whole-document dedup reuses `fdh_statement_uploads.file_hash` uniqueness (existing FDH-1/FDH-3 mechanism, unmodified); no FDH-10-specific duplicate-STATEMENT test was written this pass since the underlying mechanism is unchanged and already certified in FDH-3 |
| FDH-9-bridge negative-control set (no-apply, approve-without-apply, forged-status, stale, duplicate-apply, concurrent-apply, forbidden-column, foreign-target) | PASS (all, for the liability domain) | `fdh10LiabilityBridge.test.ts` + `fdh10_security_certification.mjs` |

## Minimum certification bars (spec section 147) — status

| Bar | Status |
|---|---|
| card-purchase+bank-repayment | PASS |
| loan-principal-vs-interest | PASS |
| loan-drawdown-not-income | PASS |
| credit-card-balance-not-expense | PASS (structural: `statementReconciliation.ts` has no expense-shaped output field at all) |
| cash-advance-not-expense | PASS |
| refund | PASS (classification only; full refund-netting reuses FDH-7's existing oracle, not re-tested here) |
| fee | PASS |
| interest | PASS |
| duplicate-statement | PARTIAL (see above) |
| bank-payment-duplicate | PASS (bank matching links to an EXISTING transaction; structurally cannot create a duplicate cash outflow) |
| YTD/statement-totals-where-applicable | NOT APPLICABLE this pass (no extraction pipeline produces YTD figures for cards/loans; not part of the spec's card/loan scope in the way FDH-9's payslip YTD was) |
| exact-0.01-reconciliation | PASS |

## Scenario volume (spec section 95)

This pass certified the two headline controls and the full bridge/security matrix in depth (per this dispatch's stated priority order) rather than the full 150+ scenario / 40+/30+/30+/30+/20+ breakdown by country and product. Total dedicated FDH-10 test count: **52 vitest unit tests + 18 real-Postgres security checks = 70 scenarios**, all genuinely executed and passing, none asserted without a run. This is honestly below the 150+ target; see `FDH10_COMPLETION_REPORT.md` for the gap disclosure.
