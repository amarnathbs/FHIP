# PDF wording and file chooser follow the per-class route switch (20-10-2026)

## Problem
Production main 7b26956 (Amplify 322): the Liabilities, Retirement and Australian-investment import screens said
"Statement file (PDF or CSV)" and offered PDF in the file chooser, but `AIE_*_PDF_ROUTE_ENABLED` is unset (OFF), so the
server refuses a PDF with `PDF_ROUTE_DISABLED_MESSAGE` (403). Users were invited to upload a PDF and then refused.

## Change (visibility only; the server stays authoritative)
- `GET /api/financial-data-hub/upload-status` (existing authenticated read) now also returns
  `data.pdf_routes = { liability, retirement, au_investment }`, resolved on the server from `flags.ts`. No env var is
  exposed to the client bundle and no `NEXT_PUBLIC` is used.
- `lib/financial-data-hub/pdf-statements/uiVisibility.ts` (new, pure, reads no env): `parsePdfRouteVisible` (only the literal
  boolean `true` for that class counts), `statementFileAccept`, `statementFileLabel`.
- `components/financial-data-hub/PdfAwareStatementCopy.tsx` (new): the intro copy and file field per class, in both states.
- The three panels start with `pdfRouteEnabled = false` (CSV only), set it from the existing upload-status fetch, and reset it
  to false when that fetch fails. Fail closed.

| State | Copy | Chooser `accept` |
|---|---|---|
| OFF (default) | exact pre-PDF-routes wording ("Statement file (CSV)", "statement (CSV)", AU "CSV" intro and "currently reads two generic Australian CSV layouts", retirement "CSV exports only in this release") | liability/AU `text/csv,.csv`; retirement `.csv,text/csv` |
| ON | current "PDF or CSV" wording | PDF and CSV |

Not changed: the upload route refusal, every switch default, the AI-fallback switches, and the bank statement (Expenses),
payslip and Investment Intelligence screens. No migration, no secrets, no production access.

## Tests
`tests/unit/pdfRouteLabelFollowsSwitch.test.ts` (21 tests): per class both states (copy and accept attribute); negative
control (OFF markup has no PDF wording and no pdf in accept; mutating the OFF accept made 3 tests fail by name, then
restored); fail-closed parsing (missing, null, malformed, string `'true'`, other class); panel source contracts (starts false,
set per class, reset on failure, no env, no hard-coded PDF wording left); the route returns the three booleans from the env
(unset -> all false; only the literal `'true'`; per-class independence; 401 for unauthenticated).
No existing test pinned the old wording (the e2e smoke spec already expects "Statement file (CSV)", which is the OFF state).

## Verification
- tsc: pre-existing errors only in tests/unit/canonicalCertResidueAllSql.test.ts and tests/unit/aiProductionProofPackPglite.test.ts (neither touched).
- eslint on all touched files: clean.
- 59 related files (pdfRoutes*, premiumUpload*, fdh10/11/12, aieUserDailyCap, upload-flow guards, round trips): 1625 pass; 2 timeouts under parallel load (fdh11Isolation, ownerBeforeUploadScripts) pass in isolation.
