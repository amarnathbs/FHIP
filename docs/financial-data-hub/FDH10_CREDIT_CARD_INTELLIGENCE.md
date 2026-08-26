# FDH-10 — Credit Card Intelligence

## The headline control (spec section 4)

A credit-card purchase and its later matched bank repayment are **exactly one expense, never two**. `lib/financial-data-hub/liability/creditCardEconomics.ts` makes this a type-level and functional guarantee rather than a convention:

- `classifyStatementActivity('PAYMENT')` returns `'transfer'` — never `'expense'` — categorically, for every input.
- `planCardStatementLedgerWrites()` never plans a `create_transaction` write for a matched PAYMENT activity; it plans `link_existing_bank_transaction` instead, referencing the transaction the bank-statement import already created.
- `assertNoDoubleCount()` / `totalExpenseFromPlan()` are the certification oracle: `tests/unit/fdh10CreditCardEconomics.test.ts` reproduces the exact $200+$200=$400 defect via a deliberately-injected bank-side misclassification, proves the oracle catches it (RED), then proves the correct classification passes again (GREEN).

## Economic treatment table

| Activity | Economic type | Expense? | Notes |
|---|---|---|---|
| PURCHASE | `expense` | Yes | Reuses R8/FDH-6 categorisation unmodified |
| REFUND | `refund` | Nets against expense via existing refund semantics | No new refund logic |
| PAYMENT (matched to bank txn) | `transfer` | **No** | Liability settlement, not a second expense |
| PAYMENT (unmatched) | evidence only | No write at all | `record_evidence_only` — never fabricated, never lost |
| CASH_ADVANCE | `cash_withdrawal` | No | Cash + liability increase; not spending |
| INTEREST | `debt_interest` | Yes (as interest, not principal) | |
| FEE | `fee` | Yes | Kept distinct from interest (spec 29) |

## Partial/full/over-payment (spec 27)

The adapter's `balance` field always proposes the statement's actual closing balance — whatever it is. A partial payment leaves a genuine remaining balance; a full payment reduces it to (near) zero; an overpayment can leave a legitimate credit balance (negative-looking, never auto-converted to a negative expense, since this module never writes balance-derived expense figures at all).

## Multi-currency, duplicate cards, supplementary cards (spec 71-76)

Not implemented as automatic logic in this pass — `facilityMatching.ts` distinguishes cards by masked identifier + institution + currency (never merges same-issuer cards without a matching identifier), which is the mechanism duplicate/supplementary-card correctness depends on, but no FX-conversion or supplementary-card-linking logic was written. Disclosed gap; see `FDH10_COMPLETION_REPORT.md`.

## What is NOT implemented in this pass

Per-institution parsing (issuer-specific PDF/CSV layouts), the review UI, and the upload API route are not built — see `FDH10_LIABILITIES_TAB_UX.md` and the completion report. The economic classification and double-count-prevention LOGIC above is complete, unit-certified (14 tests, `fdh10CreditCardEconomics.test.ts`), and independently reusable by whatever extraction pipeline is built next.
