# 3. Australian investment statements (broker holdings and transactions): PDF extraction specification

Existing CSV route: screen `components/investments/AuInvestmentStatementImportPanel.tsx`; routes `app/api/financial-data-hub/investment-statement/{upload,[documentId]/process,[documentId]/ai-fallback/confirm,[documentId]/security-match,[documentId]/account-match,[documentId]/approve,[documentId]/apply,...}`; service `lib/financial-data-hub/services/investmentStatementProcessingService.ts`; canonical evidence writer `persistAuInvestmentEvidence` writing `fdh_investment_statements`, `_positions`, `_activities`; totals check `lib/financial-data-hub/investment/statementTotals.ts`. Canonical Investment Intelligence changes only at the later Apply step. The CSV route reads two kinds: a transaction statement and a portfolio (holdings) statement; the PDF route supports the same two.

Statement kind (holdings or transactions), currency (AUD) and owner are chosen by the person before upload.

## 1. Fields extracted

Holdings: institution; masked account/HIN (last 4); valuation or statement date; per holding code, security name, quantity (exact decimal, up to 6 places), unit price, market value, optional cost base; cash balance; total portfolio value.
Transactions: institution; masked account; period; per line date, type (BUY, SELL, DIVIDEND, DISTRIBUTION, INTEREST, BROKERAGE, FEE, TRANSFER_IN, TRANSFER_OUT, CASH_DEPOSIT, CASH_WITHDRAWAL, DRP, OTHER), code, quantity, price, brokerage, amount (positive magnitude, the type carries direction); printed totals where present.

## 2. Certified deterministic layouts

### HOLD-1 (holdings)
```
<Broker>                                           first line
HOLDINGS STATEMENT                                 also PORTFOLIO VALUATION / HOLDINGS VALUATION
Account: <name>   HIN: X0000 4417                  last 4 kept
Valuation date: 30/06/2026                         or Statement date:
Code Security Quantity Price Value                 header (an optional trailing Cost base column)
ARX Arrowroot Industries Limited 500.0000 18.4200 9,210.00
Cash balance: $1,250.00                            optional
Total portfolio value: $137,021.65                 optional but needed to certify
```
Row: a 2-5 character uppercase code, the name, quantity, price, value (and optionally cost base). The header repeats on later pages and a `continued` line is a page marker. `Cash balance` and `Total portfolio value` (also `Total`, `Portfolio total`) are summary lines, never holdings.

### TXN-1 (transactions)
```
<Broker>
TRANSACTION STATEMENT                              also ACTIVITY STATEMENT
Account: <name>   HIN: X0000 4417
Statement period: 01/07/2026 to 31/07/2026
Date Type Code Quantity Price Brokerage Amount
02/07/2026 BUY BMT 100.0000 98.1000 19.95 9,829.95
15/07/2026 DIVIDEND CNP - - - 127.50               "-" for an empty cell
Total buys: $11,549.90     Total sells: ...        optional printed totals
```
Amount rule: BUY amount = quantity x price + brokerage; SELL amount = quantity x price - brokerage (net proceeds); both within the 0.01 rounding rule.

### Never holdings or transactions
Total, cash, subtotal, page marker, `continued`, and footnote lines beginning `Note`. Identical genuine rows (two fills of the same size on one day) are both kept.

### Strictness
Inside the table every non-blank line must be a row, a summary line, a header repeat, or a page marker; anything else is `unread_lines` and the fallback is offered.

## 3. Reconciliation rules

* Holdings: each holding `quantity x price = value` within 0.01; sum of holding values (plus cash) equals the printed total exactly (existing `reconcileAuStatementTotals`, which tries holdings alone and holdings plus cash). A printed total that is missing is `insufficient_data`.
* Transactions: each line's arithmetic as above; printed totals equal the sum of the lines exactly (buys, sells, brokerage); a statement with a failed line check is stored as `variance`.
* Cost base, where stated, is carried as the holding's stated figure and is not recomputed (no cost-base rule exists in the canonical writer; it is evidence only).
* Certified = reconciled and no warning. A failed line check, a total mismatch, an unreadable line or a missing total = review required.

## 4. Refusal and review conditions

| Condition | Result |
|---|---|
| encrypted, image only, corrupt, timeout, over 60 pages | refused, no AI |
| not a broker or investment statement (a bank statement, a super statement, a letter) | `not_this_class`, nothing charged |
| two accounts in one document (two HINs with two totals) | `multiple_accounts` |
| HOLD-1 / TXN-1 not matched (for example one block of labelled lines per holding) | `layout_unsupported` -> AI fallback |
| unreadable row | `unread_lines` -> AI fallback |
| wrong arithmetic printed on the page | read as printed, stored as `variance`, never certified |

## 5. AI fallback specifics

The existing adapter (`AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED`) reads the masked text. Added for PDF: any drafted holding or transaction whose value or amount is not printed in the text is dropped with a warning. Currency and institution context come from the person.

## 6. Audit events

No new event type: `pdf_validated`, `investment_statement_extraction_completed` / `_failed`, `investment_statement_ai_fallback_*` with `source_format: pdf` and the reader outcome code in the metadata.
