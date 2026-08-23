# FDH-4 — Bank Adapter Coverage

Full matrix, all 30 AU+IN bank entries in FDH-2 master data (`data/financial-data-hub/institutionsAu.mjs`, `institutionsIn.mjs`). Not aggregated away — every unsupported bank is named explicitly (spec section 67/103).

| Country | Institution | Format | Evidence | Adapter | Status |
|---|---|---|---|---|---|
| AU | Commonwealth Bank (`cba`) | Date, Description, Debit Amount, Credit Amount, Balance | R7 (public CSV-export convention) | `au_cba_debit_credit_v1` | **CERTIFIED** (R7) |
| AU | Westpac (`westpac`) | Date, Narrative, Amount (signed), Balance, Categories, Serial | R7 (public CSV-export convention) | `au_westpac_single_signed_v1` | **CERTIFIED** (R7) |
| AU | NAB (`nab`) | Date, Transaction Details, Debit, Credit, Balance | R7 (public CSV-export convention) | `au_nab_debit_credit_v1` | **CERTIFIED** (R7) |
| AU | **ANZ** (`anz`) | Date, Transaction Description, Debit Amount, Credit Amount, Balance | FDH-4, web search, corroborated across `docuclipper.com`, `invoicedataextraction.com`, `statementsheet.com`, `aussiebankstatements.com` — see `FDH4_AU_ADAPTERS.md` | `au_anz_debit_credit_v1` | **CERTIFIED** (FDH-4) |
| AU | **Macquarie Bank** (`macquarie_bank`) | Account Number, Account Name, Transaction Date, Transaction Description, Cheque/Reference Number, Debit Amount, Credit Amount (no balance column) | FDH-4, web search — Macquarie's own business daily-file help page + `aussiebankstatements.com` | `au_macquarie_debit_credit_v1` | **CERTIFIED** (FDH-4) |
| AU | ING Australia (`ing_australia`) | — | Not found this session (no corroborated public column layout) | none | **NOT SUPPORTED** |
| AU | Bendigo Bank (`bendigo_adelaide_bank`) | — | Not found this session | none | **NOT SUPPORTED** |
| AU | Bank Australia (`bank_australia`) | — | Not searched this session (outside priority+first-secondary wave) | none | **NOT SUPPORTED** |
| AU | AMP Bank, BOQ, ME Bank, UBank, Great Southern Bank, HSBC Australia, Suncorp Bank | — | Not searched this session | none | **NOT SUPPORTED** (9 institutions) |
| IN | State Bank of India (`sbi`) | Txn Date, Description, Amount, Dr/Cr, Balance, Ref No | R7 (public CSV-export convention) | `in_sbi_dr_cr_v1` | **CERTIFIED** (R7) |
| IN | HDFC Bank (`hdfc_bank`) | Date, Narration, Withdrawal Amt, Deposit Amt, Closing Balance | R7 (public CSV-export convention) | `in_hdfc_debit_credit_v1` | **CERTIFIED** (R7) |
| IN | ICICI Bank (`icici_bank`) | Value Date, Transaction Remarks, Withdrawal Amount, Deposit Amount, Balance | R7 (public CSV-export convention) | `in_icici_dr_cr_v1` | **CERTIFIED** (R7) |
| IN | **Axis Bank** (`axis_bank`) | Tran Date, Chq No, Particulars, Debit, Credit, Balance | FDH-4, web search, corroborated across `bankstatementkit.com`, `paisabazaar.com`, `statementsheet.com` — see `FDH4_IN_ADAPTERS.md` | `in_axis_debit_credit_v1` | **CERTIFIED** (FDH-4) |
| IN | **Kotak Mahindra Bank** (`kotak_mahindra_bank`) | Date, Narration, Chq/Ref No., Withdrawal (Dr), Deposit (Cr), Balance | FDH-4, web search — `bankstatemently.com`, `statementsheet.com`, `bridgebanks360.com` | `in_kotak_debit_credit_v1` | **CERTIFIED** (FDH-4) |
| IN | IDFC FIRST Bank (`idfc_first_bank`) | — | Not found this session | none | **NOT SUPPORTED** |
| IN | Bank of Baroda (`bank_of_baroda`) | — | Not found this session | none | **NOT SUPPORTED** |
| IN | Punjab National Bank (`pnb`) | — | Not found this session | none | **NOT SUPPORTED** |
| IN | Canara Bank, Union Bank of India, Indian Bank, IndusInd Bank, Federal Bank, Yes Bank, AU Small Finance Bank | — | Not searched this session | none | **NOT SUPPORTED** (7 institutions) |

## Coverage summary (spec section 86-87 — do not overstate)

```
AU priority wave (CBA, ANZ, NAB, Westpac):      4/4 CERTIFIED — COMPLETE
AU secondary wave attempted (Macquarie):        1/4 CERTIFIED (ING, Bendigo, Bank Australia — NOT SUPPORTED, no evidence found)
AU overall:                                     5/15 banks CERTIFIED, 10/15 NOT SUPPORTED

IN priority wave (SBI, HDFC, ICICI, Axis):      4/4 CERTIFIED — COMPLETE
IN secondary wave attempted (Kotak Mahindra):   1/4 CERTIFIED (IDFC FIRST, Bank of Baroda, PNB — NOT SUPPORTED, no evidence found)
IN overall:                                     5/15 banks CERTIFIED, 10/15 NOT SUPPORTED
```

**Do not read this as "FHIP supports Australian/Indian banks."** It supports exactly the 10 banks listed CERTIFIED above. Every other AU/IN bank in FDH-2 master data remains `coverage_status = master_only` (institution exists for reference/matching purposes; no CSV parser exists for it) and, on upload, resolves to `manual_mapping_required` or `ambiguous` — never a silent guess, never an incorrectly-imported value (spec section 24/114).

## Institution coverage_status discipline (spec section 33)

Migration `0066` advances `coverage_status` from `master_only` to `parser_certified` for **exactly** `(AU,anz)`, `(AU,macquarie_bank)`, `(IN,axis_bank)`, `(IN,kotak_mahindra_bank)` — the same governed, additive pattern migration 0064 used for the original 6. No other institution row is touched. No PDF/OCR support is implied by CSV certification (spec section 33) — `coverage_status = parser_certified` here means "a CSV adapter exists," nothing about statement PDFs.

**Not yet live**: migration `0066` has not been applied to DEV or production (no DDL-execution credential in this environment). Until it is, the 4 new adapters function correctly in the code registry (detection/normalization/reconciliation all proven via the independent oracle and vitest) but cannot be exercised through the live processing pipeline, which does a live `fdh_parser_registry`/`fdh_parser_versions` lookup by `parser_key` before creating transactions. See `FDH4_COMPLETION_REPORT.md` residuals.
