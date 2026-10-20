# Expected values for the synthetic proof documents

Every institution, person, employer, number and address in these files is **invented**. The planted "personal" details (a name, an e-mail, a
mobile number, a bank account, a tax file number, a member number, a PAN) exist only to prove that masking removes them before anything leaves
the server. Nothing here is a real person or a real account.

**How these figures were fixed.** Each figure below was worked out by hand (the arithmetic is shown) before any parser or model was run, and a
unit test (`tests/unit/aiProductionProofDocuments.test.ts`, UNIT-TESTED) recomputes the arithmetic in whole cents. They are the *oracle*: when you
compare the app's result with this sheet, a difference is a finding, not a rounding detail. All dates below are day-first (dd/mm/yyyy).

**Check the file before you upload it.** `MANIFEST.sha256` lists the SHA-256 of each file. In PowerShell:
`Get-FileHash -Algorithm SHA256 .\DOC-B1_bank_statement_kestrel_coast_aug2026.pdf` must print the hash in the table below. If a hash differs, do
not upload that file; tell the engineer.

| Id | File | Class | Format | Uploader | SHA-256 |
|---|---|---|---|---|---|
| DOC-B1 | `DOC-B1_bank_statement_kestrel_coast_aug2026.pdf` | Bank statement | PDF (document-scanning path) | P1 | `a0be00a022f591a14f8da2f8220c659db2c0922df9f857898ad02f4ba648bb35` |
| DOC-B2 | `DOC-B2_bank_statement_marlowe_valley_aug2026.pdf` | Bank statement | PDF | P2 | `4493eaae2b998daf36895d491d1491cfaec72e020f06c547a229123e1344356f` |
| DOC-B3 | `DOC-B3_bank_statement_marlowe_valley_sep2026_wrong_closing.pdf` | Bank statement, wrong on purpose | PDF | P2 | `12cdf10bec4a82ddca45b2cfc8dba3d3eb11f152fcd35c2745ac8fbd597d860b` |
| DOC-P1 | `DOC-P1_payslip_remittance_advice_aug2026.pdf` | Payslip | PDF | P1 | `4b47daca346e9d287f7dbffe9532682c166a123d52e255cd75a0d7ffa3d292d3` |
| DOC-L1 | `DOC-L1_credit_card_letter_jul2026.csv` | Liability (credit card) | CSV (structured-file path) | P1 | `0ce6f2a72429b19f873a0647bb20ad3f4b9c35922aa65ec79c2bfb1ab6d6eb2f` |
| DOC-R1 | `DOC-R1_super_member_letter_jul2026.csv` | Retirement (super) | CSV | P1 | `2deb63df6e21dac5307ccb0a343b3a3f4125ea6fdad58d1959b871a443a72549` |
| DOC-A1 | `DOC-A1_broker_activity_letter_jul2026.csv` | Australian investment | CSV | P1 | `12772eb61c09fe17fd7054bbbaed7672ac8078d9ac623a7380d1e5c9807313d9` |
| DOC-I1 | `DOC-I1_investment_holdings_letter_aug2026.pdf` | Investment Intelligence statement | PDF | P1 | `82b4bc2039e7a1cdaf336ef0aab25cc3f6df97b1efc5c8a0d15d6f88a8a46d48` |

**PDF versus CSV.** A PDF exercises the document-scanning path (upload, real malware scan of a PDF object, text extraction, masking). A CSV
exercises the structured-file path and its own scan, but a CSV run is **never** evidence about how a PDF is scanned or read. The first journey
(DOC-B1) is a PDF on purpose.

**Why the deterministic reader cannot read these (so the AI step is genuinely needed).** Nothing was disabled or broken. The bank PDF layout
parsers are certified for four named Australian banks; a statement from any other institution is an "unsupported layout", which is the
everyday case for a real user. The other classes are written as letters in sentences with no column table. A unit test runs the real
deterministic reader over every file and also over a control statement in a supported layout, which it reads natively.

---

## DOC-B1: bank statement, Kestrel Coast Community Bank (invented), 01/08/2026 to 31/08/2026

Uploader: P1. Printed table: Date, Description, Amount (plus sign for money in, minus sign for money out), Balance.

| Date | Description (as printed) | Direction | Amount | Running balance printed |
|---|---|---|---|---|
| (opening) | | | | 3,215.40 |
| 03/08/2026 | SALARY SYNTHETIC WORKS PTY LTD | credit | 2,450.00 | 5,665.40 |
| 05/08/2026 | RENT IMAGINARY REALTY | debit | 1,380.00 | 4,285.40 |
| 09/08/2026 | FICTIONAL GROCER | debit | 164.85 | 4,120.55 |
| 14/08/2026 | ELECTRICITY SAMPLE ENERGY | debit | 212.30 | 3,908.25 |
| 19/08/2026 | REFUND FICTIONAL APPLIANCES | credit | 500.00 | 4,408.25 |
| 26/08/2026 | PHARMACY IMAGINARY | debit | 38.60 | 4,369.65 |

Arithmetic: 3,215.40 + 2,450.00 = 5,665.40; minus 1,380.00 = 4,285.40; minus 164.85 = 4,120.55; minus 212.30 = 3,908.25; plus 500.00 = 4,408.25;
minus 38.60 = 4,369.65. Money out 1,380.00 + 164.85 + 212.30 + 38.60 = **1,795.75**. Money in 2,450.00 + 500.00 = **2,950.00**.
Check: 3,215.40 + 2,950.00 - 1,795.75 = **4,369.65** = printed closing balance.

Expected AI reading: 6 transactions, opening 3,215.40, closing 4,369.65, period 01/08/2026 to 31/08/2026, institution Kestrel Coast Community Bank, every
direction as in the table, every running balance as printed. **No account digits** may reach the model and none may be stored beyond the last four.
Expected after acceptance: 6 transactions on the account, money in 2,950.00, money out 1,795.75, reconciliation **reconciled** (variance 0.00),
certification **certified** (no duplicate candidates on a fresh account). The account is named after the institution only if it still carried a generic name.

## DOC-B2: bank statement, Marlowe Valley Credit Union (invented), 01/08/2026 to 31/08/2026

Uploader: P2 (a Premium account that was **never** in the former two-e-mail pilot).

| Date | Description (as printed) | Direction | Amount | Running balance printed |
|---|---|---|---|---|
| (opening) | | | | 8,120.55 |
| 04/08/2026 | SALARY QUILLFEATHER STUDIO PTY LTD | credit | 3,100.00 | 11,220.55 |
| 06/08/2026 | HOME LOAN REPAYMENT IMAGINARY HOME LOANS | debit | 2,250.00 | 8,970.55 |
| 11/08/2026 | FICTIONAL SUPERMARKET | debit | 212.75 | 8,757.80 |
| 17/08/2026 | INSURANCE PREMIUM SAMPLE MUTUAL | debit | 96.40 | 8,661.40 |
| 21/08/2026 | INTEREST PAID | credit | 4.15 | 8,665.55 |
| 28/08/2026 | FUEL FICTIONAL PETROLEUM | debit | 71.30 | 8,594.25 |

Arithmetic: 8,120.55 + 3,100.00 = 11,220.55; minus 2,250.00 = 8,970.55; minus 212.75 = 8,757.80; minus 96.40 = 8,661.40; plus 4.15 = 8,665.55;
minus 71.30 = 8,594.25. Money out 2,250.00 + 212.75 + 96.40 + 71.30 = **2,630.45**. Money in 3,100.00 + 4.15 = **3,104.15**.
Check: 8,120.55 + 3,104.15 - 2,630.45 = **8,594.25** = printed closing balance.
Expected after acceptance: 6 transactions, reconciled, certified. P1 must not be able to see any of this (cross-tenant check).

## DOC-B3: bank statement with an arithmetic error on the page (optional journey 1b)

Marlowe Valley Credit Union, 01/09/2026 to 30/09/2026, uploader P2, **after** DOC-B2 has been accepted (it opens where DOC-B2 closes).

| Date | Description (as printed) | Direction | Amount | Running balance printed | Correct balance |
|---|---|---|---|---|---|
| (opening) | | | | 8,594.25 | |
| 02/09/2026 | SALARY QUILLFEATHER STUDIO PTY LTD | credit | 3,100.00 | 11,694.25 | 11,694.25 |
| 04/09/2026 | HOME LOAN REPAYMENT IMAGINARY HOME LOANS | debit | 2,250.00 | 9,444.25 | 9,444.25 |
| 10/09/2026 | FICTIONAL SUPERMARKET | debit | 188.20 | **9,300.00** | **9,256.05** |

Arithmetic: 8,594.25 + 3,100.00 = 11,694.25; minus 2,250.00 = 9,444.25; minus 188.20 = **9,256.05**. The page prints **9,300.00** as the last running balance
and as the closing balance: wrong by **43.95**. Money out 2,250.00 + 188.20 = 2,438.20; money in 3,100.00.
Expected: the reading reports 9,300.00 **as printed** (the model must not correct the page). The deterministic check then fails: the running balance
chain breaks at **row 3**, reconciliation **failed**, variance **43.95**, certification **review_required** (reason: reconciliation failed). The statement
must ask for the person's attention. If it is silently certified, that is a **defect**; stop and report.

## DOC-P1: payslip (remittance advice in sentences), invented employer Quillfeather Studio Pty Ltd

Pay period: the fortnight ending 14/08/2026; paid 15/08/2026. Printed as sentences, with the figures 2900.00, 300.00, 3200.00, 512.00, 200.00 and 2488.00.

Arithmetic: gross = wage 2,900.00 + allowance 300.00 = **3,200.00**. Tax withheld **512.00**. Salary sacrifice to super 200.00.
Net = 3,200.00 - 512.00 - 200.00 = **2,488.00**. Frequency: **fortnightly**. Payment date **15/08/2026**.
Expected after acceptance: one payroll event with gross 3,200.00, tax 512.00, net 2,488.00, fortnightly, paid 15/08/2026, in the Income area for the owner chosen.

## DOC-L1: credit card statement letter (CSV of sentences), invented Synthetic Card Co

Period 01/07/2026 to 31/07/2026. Opening balance owed 500.00. Purchases 05/07/2026 85.40 and 09/07/2026 42.10. Payment 15/07/2026 200.00.
Arithmetic: 500.00 + 85.40 + 42.10 - 200.00 = **427.50** owed at the end. Purchases total **127.50**, payments total **200.00**.
Expected after acceptance: a liability statement evidence record with closing balance 427.50, 3 activities, awaiting the person's approval before it
reaches the Liabilities area (see the journey for the exact step).

## DOC-R1: super member letter (CSV of sentences), invented Imaginary Super Fund

Period 01/07/2026 to 31/07/2026. Opening 10,000.00. Employer contribution 500.00 on 01/07/2026; personal contribution 200.00 on 15/07/2026; fee 12.50 on 31/07/2026.
Arithmetic: 10,000.00 + 500.00 + 200.00 - 12.50 = **10,687.50** closing. Member number and TFN are planted and must never reach the model.
Expected after acceptance: retirement statement evidence with closing 10,687.50 and the 3 activities; this is ordinary super (not a self-managed fund).

## DOC-A1: broker activity letter (CSV of sentences), invented Imaginary Broking

Buy on 02/07/2026: 50 shares of SYNTHETIC LTD (code SYN) at 40.00 = **2,000.00**, brokerage **9.95**. Cash dividend on 20/07/2026: **120.00**. The HIN is planted.
Expected after acceptance: one buy of 50 at 40.00 (2,000.00) with brokerage 9.95, and one dividend of 120.00.

## DOC-I1: Investment Intelligence statement (PDF, letter of sentences), invented Imaginary Registrar

Folio SYN-2026-0001. One holding: SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH, ISIN INF000S00001. Purchase on 05/08/2026 of 100.000 units at NAV 50.0000.
Arithmetic: 100.000 x 50.0000 = **5,000.00** cost. On 31/08/2026: 100.000 units at NAV 52.5000, market value 100.000 x 52.5000 = **5,250.00**.
The PAN, e-mail and mobile are planted and must never reach the model.
Expected after acceptance: one holding of 100.000 units, cost 5,000.00, market value 5,250.00 as at 31/08/2026, one purchase of 100.000 units for 5,000.00 on 05/08/2026.

---

## Cost expectation (for the spend check)

A single reading of one of these documents has a reserved ceiling of a few cents and a settled cost well under one cent (earlier DEV readings of
comparable documents settled between about US$0.0003 and US$0.0007, DEV-verified in October 2026). If one document settles above **US$0.01**, treat
that as a finding. The per-user daily limit is US$1.00 per UTC day; a whole proof session is expected to use well under one percent of it.
