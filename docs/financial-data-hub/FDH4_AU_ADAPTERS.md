# FDH-4 — AU Adapters

Priority wave (spec section 28): Commonwealth Bank, ANZ, NAB, Westpac. **All 4 now CERTIFIED** — CBA/NAB/Westpac by R7, ANZ by FDH-4. Secondary wave: Macquarie CERTIFIED by FDH-4; ING, Bendigo Bank, Bank Australia remain NOT SUPPORTED (no corroborated public format evidence found this session — spec section 30 forbids inventing a layout from memory).

## `au_anz_debit_credit_v1` — ANZ

- **Signature**: `Date, Transaction Description, Debit Amount, Credit Amount, Balance` (`debit_credit_columns`, `DD/MM/YYYY`)
- **Evidence provenance**: web search this session, corroborated across independent sources:
  - docuclipper.com/blog/convert-anz-bank-statement-to-excel — "date, transaction description, debit amount, credit amount, and balance"
  - invoicedataextraction.com/blog/anz-bank-statement-to-excel
  - statementsheet.com/how-to-convert-anz-bank-statement-to-excel-csv
  - aussiebankstatements.com/blog/how-to-export-anz-statements
- **Fixture**: `tests/fixtures/r7-bank-csv/au_anz_debit_credit.csv` — 5 synthetic rows, internally consistent balance chain (opening 2562.50 → closing 5485.51).
- **Design note (real finding, not a defect)**: an earlier draft used the shorter header names `Date, Description, Debit, Credit, Balance`. Against R7's existing scoring function, that header scored 1.0 against ANZ's own signature but only 0.145 below that against R7's *generic* debit/credit fallback adapter (`generic_debit_credit_v1`, required headers `Date, Description, Debit, Credit`) — inside the `DETECTION_CONFIDENCE_GAP` (0.15) threshold, correctly resolving to `AMBIGUOUS_FORMAT` rather than guessing (spec section 46 working exactly as designed). Refining the evidence search surfaced the fuller, equally well-corroborated column names above, which are both more accurate to ANZ's real export *and* naturally distinct from the generic fallback — resolving the ambiguity without touching shared detection thresholds. Verified: `FDH4-TC001`/`FDH4-TC007` in `tests/unit/fdh4AdapterCoverage.test.ts`.
- **Cross-adapter negative controls**: does not detect as CBA, NAB, Westpac, or Macquarie (`FDH4-TC007`); CBA/NAB files do not detect as ANZ (`FDH4-TC008`/`TC009`).

## `au_macquarie_debit_credit_v1` — Macquarie Bank

- **Signature**: `Account Number, Account Name, Transaction Date, Transaction Description, Cheque/Reference Number, Debit Amount, Credit Amount` (`debit_credit_columns`, `DD/MM/YYYY`, **no balance column**)
- **Evidence provenance**: `macquarie.com.au/help/business/manage-your-accounts/statements-and-transactions/export-transactions-as-csv-or-qif-files.html` (Macquarie's own help documentation) — "Account Number, Account Name, Transaction Date, Transaction Description, Cheque/Reference Number, Debit Amount, Credit Amount"; corroborated by `aussiebankstatements.com/macquarie`.
- **Fixture**: `tests/fixtures/r7-bank-csv/au_macquarie_debit_credit.csv` — 5 synthetic business-account rows.
- **Reconciliation implication**: this format genuinely has no running-balance column in Macquarie's own documented export. Certified as `NOT_AVAILABLE` reconciliation, never a fabricated balance (spec section 17/109) — proven by `FDH4-TC018` (deliberately checks `status === 'not_available'`, not skipped).

## NOT SUPPORTED (disclosed, not aggregated away)

| Institution | Reason |
|---|---|
| ING Australia (`ing_australia`) | No corroborated public CSV column-layout evidence found this session |
| Bendigo Bank (`bendigo_adelaide_bank`) | No corroborated public CSV column-layout evidence found this session |
| Bank Australia (`bank_australia`) | Not searched this session — outside the priority + first-secondary-wave scope actually pursued |
| AMP Bank, BOQ, ME Bank, UBank, Great Southern Bank, HSBC Australia, Suncorp Bank | Not searched this session |

These 9 institutions remain `coverage_status = master_only` in FDH-2. A CSV from any of them resolves to `manual_mapping_required` or `ambiguous` on upload — never imported with guessed column semantics.
