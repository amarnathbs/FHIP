# FDH5_IN_PDF_ADAPTERS

All 4 India priority-wave institutions (spec 50: SBI, HDFC, ICICI, Axis) are covered. See `lib/financial-data-hub/bank-pdf/adapters/inAdapters.ts` for the executable definitions — this document summarises them; the code is authoritative.

| Adapter | `parser_key` | Date format | Amount convention | Required markers |
|---|---|---|---|---|
| State Bank of India | `in_sbi_pdf_v1` | `DD Mon YYYY` | `dr_cr_indicator` | "State Bank of India", "Account Statement" |
| HDFC Bank | `in_hdfc_pdf_v1` | `DD/MM/YYYY` | `single_signed` | "HDFC Bank", "Statement of Account" |
| ICICI Bank | `in_icici_pdf_v1` | `DD-Mon-YYYY` | `dr_cr_indicator` | "ICICI Bank", "Account Statement" |
| Axis Bank | `in_axis_pdf_v1` | `DD/MM/YYYY` | `single_signed` | "Axis Bank", "Statement of Account" |

## Indian currency-grouping certification (spec 40)

Indian lakh/crore comma grouping (`1,23,456.78`, `99,99,999.99`) is certified explicitly for the ICICI adapter in `tests/unit/fdh5FinancialIntegrity.test.ts` ("INR Indian-grouped amounts... parse identically to Western grouping") — `bank-csv/amount.ts`'s `parseAmountField` strips ALL commas regardless of grouping position, so Indian and Western grouping are handled by the exact same, unmodified primitive; no India-specific amount parser exists or is needed.

## Password-protected statements — the flagged scrutiny area (spec 50)

India bank statements are commonly password-protected in practice; FDH-5's password handling is deliberately generic/institution-agnostic rather than India-specific (see FDH5_BANK_PDF_ADAPTER_COVERAGE.md's correction note) — the SAME transient in-memory decrypt path serves all 8 adapters, so "specifically consider" is satisfied by applying EXTRA adversarial certification effort to that shared path (live-DEV artifact-absence proof, rate limiting, non-persistence static audit) rather than by writing a second, India-only password code path. Full detail: FDH5_PASSWORD_PROTECTED_PDF.md.

## Negative cross-bank certification (spec 95)

Same suite as AU (`tests/unit/fdh5AdapterCertification.test.ts`) proves all 4 India fixtures score exactly 0 against every other adapter (AU and IN combined) — 8/8 negative controls pass across the full registry.

## Certification status

CERTIFIED for native-text extraction, all 4. NOT CERTIFIED for OCR. Evidence: synthetic structural fixture per adapter (spec 52-54) — no real customer statement.
