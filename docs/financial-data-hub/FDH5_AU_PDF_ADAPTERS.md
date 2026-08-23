# FDH5_AU_PDF_ADAPTERS

All 4 AU priority-wave institutions (spec 49: CBA, ANZ, NAB, Westpac) are covered. See `lib/financial-data-hub/bank-pdf/adapters/auAdapters.ts` for the executable definitions (signature markers, date format, amount convention, header/footer patterns, metadata patterns) — this document summarises them; the code is authoritative.

| Adapter | `parser_key` | Date format | Amount convention | Required markers |
|---|---|---|---|---|
| Commonwealth Bank | `au_cba_pdf_v1` | `DD Mon YYYY` | `dr_cr_indicator` (amount + DR/CR suffix) | "Commonwealth Bank", "Statement of Account" |
| ANZ | `au_anz_pdf_v1` | `DD/MM/YYYY` | `single_signed` | "Australia and New Zealand Banking Group", "Account Statement" |
| National Australia Bank | `au_nab_pdf_v1` | `DD-MM-YYYY` | `dr_cr_indicator` | "National Australia Bank", "Transaction Listing" |
| Westpac | `au_westpac_pdf_v1` | `DD/MM/YYYY` | `single_signed` | "Westpac Banking Corporation", "Account Transactions" |

Deliberately different date/amount conventions per bank (matching the historical pattern R7's own CSV adapters already exhibited across these same 4 institutions) — this is what makes the cross-bank negative controls (spec 95) meaningful rather than trivial: a CBA fixture genuinely cannot satisfy ANZ's amount-parsing expectations even if its brand markers were spoofed, because the underlying row shape differs too.

## Negative cross-bank certification (spec 95)

`tests/unit/fdh5AdapterCertification.test.ts`'s "negative cross-bank controls" suite proves every one of these 4 fixtures scores **exactly 0** against every OTHER adapter's `scoreText()` (all 7 other adapters, AU and IN combined) — not merely a low score, a hard zero, because `scoreTextAgainstSignature` requires ALL required markers present or returns 0 outright.

## Certification status

CERTIFIED for native-text extraction, all 4. NOT CERTIFIED for OCR (no provider integrated this phase — see FDH5_OCR_ARCHITECTURE.md). Evidence: synthetic structural fixture per adapter (spec 52-54) — no real customer statement.
