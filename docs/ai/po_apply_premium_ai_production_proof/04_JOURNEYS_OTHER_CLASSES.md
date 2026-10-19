# 4. The same proof for payslip, liability, retirement, Australian investment and Investment Intelligence

Run these only after Journey 1 passed (the scan, provider, masking, cost and deletion machinery is shared). All use **P1** (Premium, never in the
pilot). Each journey is: upload, scan clean, "AI-read draft" appears, compare with the sheet, accept, check the result, replay, check the cost.
Take `sql/A02` before and after each; each reading should settle **under US$0.01**.

**Format reminder (see `02_...`).** Only the payslip (DOC-P1) and Investment Intelligence (DOC-I1) journeys are **PDF** and exercise the
document-scanning path again. The liability, retirement and Australian investment journeys are **CSV**: they prove the structured-file path.
They are valid evidence for that path only. There is **no PDF route** for those three classes (IMPLEMENTATION GAP G-1): a person who has only a
PDF statement for a card, a super fund or a broker cannot use the AI reading today, and the screen says so.

| # | Class | Screen | File | Format | Evidence ids |
|---|---|---|---|---|---|
| 4.1 | Payslip | Income, payslip import | `DOC-P1_payslip_remittance_advice_aug2026.pdf` | PDF | `sql/E01`, `E02`, `E04`, `E07` |
| 4.2 | Liability (credit card) | Liabilities, import | `DOC-L1_credit_card_letter_jul2026.csv` | CSV | `E01`, `E02`, `E04`, `E07` |
| 4.3 | Retirement (super) | Retirement, import | `DOC-R1_super_member_letter_jul2026.csv` | CSV | `E01`, `E02`, `E04`, `E07` |
| 4.4 | Australian investment | Investments, import | `DOC-A1_broker_activity_letter_jul2026.csv` | CSV | `E01`, `E02`, `E04`, `E07` |
| 4.5 | Investment Intelligence | Investment Intelligence, statement upload | `DOC-I1_investment_holdings_letter_aug2026.pdf` | PDF | `E08`, `E04`, `E10` |

For every row: the owner is asked before the file (choose **Self**). For the metadata the screen asks (statement type, institution name, period),
use what the sheet says for that document.

## 4.1 Payslip (DOC-P1)

Expected draft: employer Quillfeather Studio Pty Ltd, gross **3,200.00** (base 2,900.00 plus allowances 300.00), tax **512.00**, salary sacrifice 200.00, net **2,488.00**,
**fortnightly**, paid **15/08/2026**. DEV-verified on 19/10/2026: gross 3,200, tax 512, net 2,488, fortnightly, paid 15/08/2026, one metered attempt.
After accepting: `E07` row `payroll` shows one record with gross 3200.00, tax 512.00, net 2488.00, text `fortnightly`, paid 2026 date shown by the database as a date (read it day-first: 15/08/2026).
The income screen shows the payslip for the owner you chose. A payslip needs approval before it counts in income: record what the screen says.

## 4.2 Liability (DOC-L1)

Expected draft: opening **500.00**, three activities (purchase 85.40 on 05/07/2026, purchase 42.10 on 09/07/2026, payment 200.00 on 15/07/2026), closing **427.50**.
After accepting, `E07`: `liability` one record (closing 427.50, payments_total 200.00), `liability_activities` three records (purchases 127.50, payments 200.00). The statement awaits
your approval before it reaches the Liabilities figures; record whether the screen shows that state, then approve it and record the result.

## 4.3 Retirement (DOC-R1)

Expected draft: opening **10,000.00**, employer contribution **500.00** (01/07/2026), personal contribution **200.00** (15/07/2026), fee **12.50** (31/07/2026), closing **10,687.50**.
The member number and tax file number must not appear anywhere in the draft or the stored rows (search the draft screen for the digits 99887766 and 123 456 782).
After accepting, `E07` rows `retirement` and `retirement_activities` show 10,687.50 and 500.00 / 200.00 / 12.50. It is ordinary super; it must not be routed as a self-managed fund.

## 4.4 Australian investment (DOC-A1)

Expected draft: a buy of **50** units of SYNTHETIC LTD (SYN) at **40.00** on 02/07/2026 for **2,000.00**, brokerage **9.95**, and a dividend of **120.00** on 20/07/2026.
The HIN must not appear. After accepting, `E07` row `au_investment` shows one statement with extraction status and approval state; read the activities on the Investments screen.

## 4.5 Investment Intelligence (DOC-I1)

Needs migration **0160** on the database (`sql/A01` row "Investment Intelligence AI reviews"). **On DEV that table is absent today, so this journey could not be rehearsed on DEV.**
Expected: the document ends **ai_review_pending**; the review panel shows one holding SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH (ISIN INF000S00001), a purchase on 05/08/2026
of **100.000** units at NAV 50.0000 = **5,000.00**, and 100.000 units at NAV 52.5000 on 31/08/2026 = **5,250.00**. PAN, e-mail and mobile absent. Accept it once.
`sql/E08`: `ai_reviews` shows `accepted:...`, `transactions_written` 1, `purchase_amount` 5000.00, `purchase_units` 100.000, original storage removed (`storage_purged_at` set).
Replay: accepting twice must not write twice (`transactions_written` stays 1). Reject path: upload a second distinct II file and reject it: nothing is written.

## 4.6 Evidence per journey

Use the block in `07_EVIDENCE_TEMPLATE.md`. State the format (PDF or CSV) in the block; a CSV block can never be cited as scan-path evidence for a PDF class.
