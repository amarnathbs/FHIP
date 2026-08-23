# R7 — Adapter Registry

`lib/financial-data-hub/bank-csv/adapters/registry.ts`. Each adapter has a mirror governance row in `fdh_parser_registry`/`fdh_parser_versions` (seeded by migration 0064).

| `id` | Institution | Country | Amount convention | Date format | Certification |
|---|---|---|---|---|---|
| `au_cba_debit_credit_v1` | Commonwealth Bank (`cba`) | AU | `debit_credit_columns` | `DD/MM/YYYY` | **certified** |
| `au_westpac_single_signed_v1` | Westpac (`westpac`) | AU | `single_signed` | `DD/MM/YYYY` | **certified** |
| `au_nab_debit_credit_v1` | NAB (`nab`) | AU | `debit_credit_columns` | `DD/MM/YYYY` | **certified** |
| `in_sbi_dr_cr_v1` | State Bank of India (`sbi`) | IN | `dr_cr_indicator` | `DD/MM/YYYY` | **certified** |
| `in_hdfc_debit_credit_v1` | HDFC Bank (`hdfc_bank`) | IN | `debit_credit_columns` | `DD/MM/YYYY` | **certified** |
| `in_icici_dr_cr_v1` | ICICI Bank (`icici_bank`) | IN | `debit_credit_columns` | `DD/MM/YYYY` | **certified** |
| `generic_single_signed_v1` | none (country-neutral) | none | `single_signed` | `YYYY-MM-DD` | EXPERIMENTAL |
| `generic_debit_credit_v1` | none (country-neutral) | none | `debit_credit_columns` | `YYYY-MM-DD` | EXPERIMENTAL |

**6 of 8 adapters are CERTIFIED** — satisfying spec §61's "prove the architecture works across multiple distinct CSV shapes" with all three structural amount conventions (single-signed, debit/credit columns, Dr/Cr indicator) and both AU and IN institutions, plus different header names/order and different optional-column shapes.

## Certification basis (spec §60, §63)

Certified means tested against a **synthetic, representative structural fixture** (`tests/fixtures/r7-bank-csv/*.csv`) matching each institution's own publicly-documented CSV-export column layout — never a real customer statement, account number, or transaction history. `fdh_financial_institutions.coverage_status` moves from FDH-2's `master_only` to `parser_certified` for exactly these 6 institutions (migration 0064's final `UPDATE`) — no other institution's coverage status changes.

The two `generic_*` adapters are labelled `EXPERIMENTAL` in code (`certificationState: 'experimental'`) and registered as `fdh_parser_versions.status = 'development'` (never `'certified'`) — they exist purely as a structural fallback for a plausible, valid CSV that does not match a known institution, per spec §60's requirement to never present an unproven format as certified.

## Extending the registry

Adding a 9th adapter requires: a `BankCsvAdapter` object (`adapters/types.ts` interface), a synthetic fixture + `.profile.json` for the independent oracle, a `fdh_parser_registry`/`fdh_parser_versions` seed row (additive migration), and certification cases proving DETECTED status against the fixture and 0 discrepancies against the independent oracle before its `certificationState` may be set to `'certified'`.
