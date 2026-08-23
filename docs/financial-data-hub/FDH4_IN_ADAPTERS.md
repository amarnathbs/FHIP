# FDH-4 — India Adapters

Priority wave (spec section 29): State Bank of India, HDFC Bank, ICICI Bank, Axis Bank. **All 4 now CERTIFIED** — SBI/HDFC/ICICI by R7, Axis Bank by FDH-4. Secondary wave: Kotak Mahindra Bank CERTIFIED by FDH-4; IDFC FIRST Bank, Bank of Baroda, Punjab National Bank remain NOT SUPPORTED (no corroborated public format evidence found this session).

## `in_axis_debit_credit_v1` — Axis Bank

- **Signature**: `Tran Date, Chq No, Particulars, Debit, Credit, Balance` (`debit_credit_columns`, `DD/MM/YYYY`)
- **Evidence provenance**: web search this session:
  - bankstatementkit.com/blog/axis-bank-statement-to-csv — documents Axis Bank prints statements in **two distinct layouts**; the debit/credit-columns layout uses `Tran Date, Chq No, Particulars` alongside separate Debit/Credit columns, corroborating the header set used here.
  - paisabazaar.com/banking/axis-bank-statement
  - statementsheet.com/how-to-download-axis-bank-statement — "standard columns... Date, Narration, Reference, Value Date, Debit, Credit, Balance" (the alternate layout; not the one certified here — see limitation below)
- **Fixture**: `tests/fixtures/r7-bank-csv/in_axis_debit_credit.csv` — 5 synthetic rows, internally consistent balance chain (opening 72500.00 → closing 130370.00).
- **Limitation, disclosed**: independent sources describe Axis Bank as genuinely shipping **two different real-world CSV layouts** depending on account/export path. FDH-4 certifies only the `Tran Date/Chq No/Particulars/Debit/Credit/Balance` layout. A real Axis statement using the alternate `Date/Narration/Reference/Value Date/Debit/Credit/Balance` layout will not match this adapter's signature and will correctly resolve to `manual_mapping_required` or `ambiguous` rather than being silently misparsed. Certifying the second layout is future work, not claimed here.
- **Cross-adapter negative controls**: does not detect as HDFC, ICICI, SBI, or Kotak (`FDH4-TC011`); HDFC/ICICI/SBI files do not detect as Axis (`FDH4-TC013`/`TC014`/`TC016`).

## `in_kotak_debit_credit_v1` — Kotak Mahindra Bank

- **Signature**: `Date, Narration, Chq/Ref No., Withdrawal (Dr), Deposit (Cr), Balance` (`debit_credit_columns`, `DD/MM/YYYY`)
- **Evidence provenance**: web search this session:
  - bankstatemently.com/banks/in/kotak/bank-statement
  - statementsheet.com/en/bank-statement-converter/kotak-mahindra-bank-in
  - bridgebanks360.com/money-guide/kotak-bank-statement — "Date, Narration, Chq/Ref No., B/F, Withdrawal (Dr), Deposit (Cr), Balance"
- **Fixture**: `tests/fixtures/r7-bank-csv/in_kotak_debit_credit.csv` — 5 synthetic rows, internally consistent balance chain (opening 50000.00 → closing 100311.00).
- **Cross-adapter negative controls**: does not detect as HDFC, ICICI, SBI, or Axis (`FDH4-TC012`).

## India number formatting (spec section 35)

No new India-specific numeric-parsing code was needed. `amount.ts#parseAmountField()` (R7, reused unmodified) already strips grouping separators before the regex-validated decimal parse; R7's own certification (`R7_TESTING_AND_VERIFICATION.md`) already covers Indian lakh-style grouping (`1,23,456.78`) as a precision case. FDH-4's new fixtures deliberately used plain (non-grouped) synthetic amounts to keep the independent-oracle comparison simple — this does not narrow the underlying parser's coverage, which is unchanged R7 code.

## NOT SUPPORTED (disclosed, not aggregated away)

| Institution | Reason |
|---|---|
| IDFC FIRST Bank (`idfc_first_bank`) | No corroborated public CSV column-layout evidence found this session |
| Bank of Baroda (`bank_of_baroda`) | No corroborated public CSV column-layout evidence found this session |
| Punjab National Bank (`pnb`) | No corroborated public CSV column-layout evidence found this session |
| Canara Bank, Union Bank of India, Indian Bank, IndusInd Bank, Federal Bank, Yes Bank, AU Small Finance Bank | Not searched this session |

These 7 institutions remain `coverage_status = master_only` in FDH-2. A CSV from any of them resolves to `manual_mapping_required` or `ambiguous` on upload — never imported with guessed column semantics.
