# 1. Liability statements (credit card, loan): PDF extraction specification

Existing CSV route (found in the code, not assumed): screen `components/liabilities/LiabilityImportPanel.tsx`; routes `app/api/financial-data-hub/liability-statement/{upload,[documentId]/process,[documentId]/ai-fallback/confirm,[documentId]/approve,[documentId]/correct,[documentId]/proposal,[documentId]/match-payment}`; service `lib/financial-data-hub/services/liabilityStatementProcessingService.ts`; canonical writer `persistLiabilityStatementEvidence` (database function `fdh10_persist_liability_statement`, migration 0208) writing `fdh_liability_statements` and `fdh_liability_statement_activities`; reconciliation `lib/financial-data-hub/liability/statementReconciliation.ts`; canonical liability only changes at the later apply step (`lib/import-bridge`).

Statement type (credit card or loan), country, currency and owner are chosen by the person BEFORE upload and are never taken from the document or the model. For a loan PDF the person also chooses the loan type (home loan, personal loan, vehicle loan, investment property loan, line of credit, overdraft, other term loan) because a wrong facility type makes the existing liability unfindable; it is never read from the page.

## 1. Fields extracted

| Field | Card | Loan | Notes |
|---|---|---|---|
| institution name | yes | yes | first line of page 1 (or `Issuer:`/`Lender:`), text |
| masked identifier | yes | yes | `Card number`/`Card ending`/`Account number`/`Loan account`; last 4 only |
| statement period start, end | yes | yes | `Statement period: dd/mm/yyyy to dd/mm/yyyy` |
| statement date | yes | yes | `Statement date:` |
| due date | yes | no | `Payment due date:` |
| opening balance | yes | yes (opening principal) | `Opening balance` or `Previous balance` |
| closing balance | yes | yes (closing principal) | `Closing balance` or `New balance` |
| credit limit | yes | no | |
| minimum payment | yes | no | |
| interest rate | no | yes | percentage as printed, `6.29% p.a.` -> 6.29 |
| activity lines | date, type, amount, description | date, type, amount, description | below |

Activity types are the existing vocabulary: PURCHASE, REFUND, PAYMENT, CASH_ADVANCE, INTEREST, FEE, PRINCIPAL, LOAN_ADVANCE, ADJUSTMENT, OTHER. Amount is always a positive magnitude.

## 2. Certified deterministic layouts

### CARD-1 (credit card)
```
<Institution>                                    first line
CREDIT CARD STATEMENT                            title (a line containing CREDIT CARD and STATEMENT)
Card number: 5999 0000 1111 4821                 or Card ending 4821
Statement period: 01/07/2026 to 31/07/2026
Statement date: 31/07/2026
Payment due date: 25/08/2026
Credit limit: $8,000.00
Opening balance: $1,250.40
Date Description Amount                          table header (exact words, any spacing)
03/07/2026 FICTIONAL GROCER 84.20                charge: positive amount, no suffix
09/07/2026 PAYMENT RECEIVED - THANK YOU 500.00 CR  credit: suffix CR
Closing balance: $1,407.80
Minimum payment: $35.00
```
Type rules (first match wins): a credit (`CR`): description contains `payment`, `direct debit` or `bpay` -> PAYMENT, otherwise REFUND. A charge: contains `fee` -> FEE; contains `interest` -> INTEREST; contains `cash advance` -> CASH_ADVANCE; otherwise PURCHASE.

### LOAN-1 (loan)
```
<Institution>
HOME LOAN STATEMENT                              any title containing LOAN and STATEMENT
Loan account: 0099 7712
Statement period: 01/08/2026 to 31/08/2026
Statement date: 31/08/2026
Interest rate: 6.29% p.a.
Opening balance: $412,300.00
Date Description Amount Balance                  table header
05/08/2026 REPAYMENT RECEIVED 2,650.00 409,650.00   amount then the running balance AFTER the line
31/08/2026 INTEREST CHARGED 2,142.50 409,142.50
Closing balance: $409,150.50
```
Direction comes from the running balance: balance after = balance before + amount (increase) or - amount (decrease); a line that is neither is a chain break. Increase: contains `interest` -> INTEREST; `fee` or `charge` -> FEE; `redraw`, `advance` or `drawdown` -> LOAN_ADVANCE; otherwise OTHER (warning). Decrease: contains `principal` -> PRINCIPAL; `repayment`, `payment` or `direct debit` -> PAYMENT; otherwise OTHER (warning). The loan identity is the existing one: opening + capitalised interest and fees + drawdowns - repayments = closing.

### Lines that are never activities
Any line whose description starts with total, subtotal, balance brought forward, balance carried forward, previous balance, opening balance, closing balance, new balance, or carries a page marker is a summary line: excluded, counted in the evidence (`summary_lines_excluded`), never an activity. Identical genuine lines are both kept.

### Strictness (the rule that makes the fallback legitimate)
Inside the table (between the table header and the closing-balance line) every non-blank line must be an activity line, a summary line, or a known page marker. Any other line (a date-led line whose tail is not a clean amount, a footnote marker on an amount, a two-digit year, a year-less date, a wrapped description) makes the reading `unread_lines`: the deterministic reader returns nothing and the fallback is offered. The reader never guesses.

## 3. Reconciliation rules

* Card: opening + purchases + cash advances + interest + fees - payments - refunds +/- adjustments = closing, exact to the cent (existing `reconcileCreditCardStatement`).
* Loan: opening + drawdowns + capitalised interest and fees - principal repayments +/- adjustments = closing (existing `reconcileLoanStatement`); additionally, in LOAN-1 every printed running balance must follow its line (a chain break is a warning `running_balance_break_row_N` and the statement cannot certify).
* A missing opening or closing balance is `insufficient_data`, never reconciled.
* Certified = reconciled and no warning. A variance of even 0.01, an unknown line type, a chain break or an unread line = review required.

## 4. Refusal and review conditions

| Condition | Result |
|---|---|
| encrypted, image only, corrupt, timeout, over 60 pages | refused, no AI |
| text does not look like a card or loan statement (for example a bank account statement, a letter) | `not_this_class`, refused, no AI, nothing charged |
| two or more different account identifiers AND two or more opening balances | `multiple_accounts`, refused |
| declared card but the text is clearly a loan, or declared loan but clearly a card | `not_this_class` |
| printed currency code differs from the declared currency | warning, review required |
| no CARD-1 / LOAN-1 match | `layout_unsupported` -> AI fallback |
| an unreadable line inside the table | `unread_lines` -> AI fallback |

## 5. AI fallback specifics

The existing liability adapter (`AIE_LIABILITY_AI_FALLBACK_ENABLED`) reads the MASKED text. Added for PDF: the provenance guard drops any drafted activity whose amount is not printed in the text; balances must be printed (existing rule). Year-less dates (`02 Aug`) are completed from the statement period only by the model; the person sees the dates day-first before confirming. The facility type of a loan is the person's choice made at upload.

## 6. Audit events

No new event type (and so no migration): the existing `pdf_validated`, `liability_statement_extraction_completed` / `_failed`, `liability_statement_ai_fallback_*` events carry `source_format: pdf` and the reader outcome code in their metadata (codes and counts only, never figures or text).
