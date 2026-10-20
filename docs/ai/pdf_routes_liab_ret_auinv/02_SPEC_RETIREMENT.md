# 2. Retirement statements (super, pension, India provident fund): PDF extraction specification

Existing CSV route: screen `components/retirement/RetirementStatementImportPanel.tsx`; routes `app/api/financial-data-hub/retirement-statement/{upload,[documentId]/process,[documentId]/ai-fallback/confirm,[documentId]/account-match,[documentId]/approve,[documentId]/proposal,[documentId]/apply,...}`; service `lib/financial-data-hub/services/retirementStatementProcessingService.ts`; canonical evidence writer `persistRetirementEvidence` writing `fdh_retirement_statements`, `_activities`, `_positions`; reconciliation `lib/financial-data-hub/retirement/reconciliation.ts`. Canonical Retirement changes only at the later Apply step. SMSF documents are routed away from ordinary super by the existing `detectSmsf` and are never ordinary evidence.

Jurisdiction (AU or IN), currency and owner are chosen by the person before upload. Account type is never taken from the model (`unknown` until the existing account-matching step), exactly as the CSV fallback does.

## 1. Fields extracted

fund name; masked member/account identifier (last 4); statement start, end and date; opening balance; closing balance; period movement totals: employer contributions, personal contributions, salary sacrifice, government contributions, rollovers in, rollovers out, withdrawals, pension payments, investment earnings (may be negative), fees, insurance premiums, tax; investment options (name, units, unit price, balance). Year-to-date figures are not extracted into the period fields.

## 2. Certified deterministic layout: RET-1 (member or pension statement, summary form)

```
<Fund name>                                        first line
ANNUAL MEMBER STATEMENT                            title containing STATEMENT (also PENSION STATEMENT)
Member number: 2204 5517                           last 4 kept
Statement period: 01/07/2025 to 30/06/2026
Account type: Accumulation                         informational (not stored as the account type)
Opening balance: $48,210.55
Employer contributions: $7,820.00                  one amount: the period figure
Personal contributions: $1,000.00
Government co-contribution: $500.00
Investment earnings: $4,012.30                     or a loss: -$812.00 or ($812.00)
Administration fees: ($231.00)                     a cost may be printed in brackets, with a minus, or plain
Investment fees: ($154.20)
Insurance premiums: ($312.00)
Tax on contributions: ($1,173.00)
Closing balance: $59,672.65
Investment options
Option Units Unit price Balance
Balanced Growth 24,000.0000 1.6500 $39,600.00
```
Known labels (case-insensitive, trailing colon optional): opening balance; closing balance; employer contributions; personal contributions (also member contributions); salary sacrifice; government co-contribution(s); rollovers in (also transfers in); rollovers out (transfers out); withdrawals; pension payments (also pension paid, income payments); investment earnings (also net investment return, investment returns, earnings); fees (also administration fees, investment fees, management fees; several are summed); insurance premiums (also insurance); tax (also tax on contributions, income tax, contributions tax; several are summed). `Total contributions` and `Total fees` are SUBTOTALS: when a subtotal is printed, its parts are not added again; the parts must sum to the subtotal or the reading carries the warning `subtotal_mismatch_<name>`.

Two-column form: a header line `This period Year to date` (any capitalisation) switches every movement line to two amounts, the FIRST being the period; the second is dropped (and counted). A movement line with two amounts and no such header is `unread_lines`.

Strictness: a line that ends in an amount and is not a known label, not an option row, not a header field is an unread line -> fallback. The reader never ignores an unknown money line.

## 3. Reconciliation rules (existing, exact)

`opening + employer + personal + salary sacrifice + government + rollovers in + earnings - rollovers out - withdrawals - pension payments - fees - insurance - tax = closing` to the cent (`reconcileFromSummaryTotals`). A missing opening or closing is `insufficient_data`. Extra checks added by the PDF reader (warnings, they force review): each option `units x price = balance` within the 0.01 rounding rule; option balances sum to the closing balance exactly (`options_do_not_sum_to_closing`); printed subtotals equal the sum of their parts. Review status for PDF-sourced statements is `pending` unless the identity is `reconciled` and no warning remains (the CSV route's rule is not weakened or changed).

## 4. Refusal and review conditions

| Condition | Result |
|---|---|
| encrypted, image only, corrupt, timeout, over 60 pages | refused, no AI |
| not a retirement statement (a card statement, a bank statement, a letter) | `not_this_class`, refused, nothing charged |
| two accounts in one document (for example an accumulation section and a pension section each with its own opening and closing balance) | `multiple_accounts`, refused |
| SMSF wording (existing detector) | stored as routed to the SMSF section, never ordinary super |
| RET-1 not matched (a transaction history form, a letter, any other layout) | `layout_unsupported` -> AI fallback |
| a money line the reader cannot place | `unread_lines` -> AI fallback |
| India (jurisdiction IN) | there is no certified deterministic India layout; an India PDF always takes the fallback and is always review required. Dates dd-mm-yyyy, amounts in lakh grouping are read |
| printed currency differs from declared | warning, review required |

## 5. AI fallback specifics

The existing retirement adapter (`AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED`) reads the masked text and returns activities and period totals; the existing `figureIsPrinted` rule drops an opening or closing balance that is not printed. Added for PDF: every drafted activity amount and period total must be printed in the text or is dropped with a warning. Jurisdiction, currency, statement type and account type come from the person's choices, never the model.

## 6. Audit events

No new event type: `pdf_validated`, `retirement_statement_extraction_completed` / `_failed`, `retirement_statement_ai_fallback_*` with `source_format: pdf` and the reader outcome code in the metadata.
