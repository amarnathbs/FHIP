# FDH5_PDF_SECURITY_MODEL

## Untrusted-input posture (spec 16)

PDF is treated as untrusted input throughout. `bank-pdf/textExtraction.ts` never executes embedded JavaScript, attachments, actions, forms, or external links — `pdf-parse`/pdf.js's text/table extraction APIs used here (`getInfo`, `getText`) do not execute any such content; no rendering, form-filling, or scripting API is called anywhere in FDH-5.

## Bounded processing (spec 18, 81-82)

- `PDF_MAX_PAGES = 60` — checked via `getInfo()` before any text extraction begins; a PDF beyond this fails as `PDF_PAGE_LIMIT_EXCEEDED` (`page_limit_exceeded`), never processed unbounded. Certified live in `tests/unit/fdh5ClassificationAndPassword.test.ts`.
- `PDF_MAX_EXTRACTED_TEXT_CHARS = 2,000,000` — a second, independent ceiling on total extracted text, defensive against a pathologically dense single page.
- `PDF_MAX_TRANSACTION_ROWS = 5,000` — checked in the orchestrator before normalisation; a statement whose row reconstruction exceeds this is rejected outright rather than silently truncated (mirrors R7's `CSV_MAX_ROWS` discipline exactly).
- FDH-3's existing 20 MB `application/pdf` size ceiling (`FDH_MAX_FILE_SIZE_BYTES`) is unchanged and reused — no FDH-5 code widens it.

## Server-only processing (spec 19)

All PDF parsing happens inside `lib/financial-data-hub/bank-pdf/*` and the two service files (`bankPdfUploadService.ts`, `bankPdfProcessingService.ts`), which run exclusively in Next.js server code (API routes under `app/api/financial-data-hub/bank-pdf/`). No PDF byte ever reaches a client component; no PDF parsing library is imported by any client-rendered module — verified by the production-build bundle scan (see FDH5_SECURITY_CERTIFICATION.md).

## No raw PDF logging (spec 20)

No file in `lib/financial-data-hub/bank-pdf/` or the two PDF services calls `console.*` with raw PDF bytes, extracted statement text, an account number, a transaction description, a customer name, or a password. Operational logging is limited to what audit events already carry: `document_id`, `adapter_id`, `parser_version`, `pages`, counts, `confidence`, `reconciliation_status`, `processing_duration` (via existing timestamp columns), and controlled `error_code`s.

## Temporary extraction artefacts (spec 21)

Extracted per-page text (`classifyPdf`'s `pages` array) is held ONLY in the request's own memory for the duration of one `runBankPdfPipeline()` call. It is never written to any table, never cached, never returned to the browser. No new storage bucket, no new table, and no new file is introduced to hold intermediate extraction state — "prefer ephemeral processing" is satisfied by simply never persisting it, the cheapest and most defensible form of compliance.

## Password handling (spec 22-25) — see FDH5_PASSWORD_PROTECTED_PDF.md for full detail

Summary: password is a plain function parameter, used exactly once for one in-memory `PDFParse({ password })` call, never written to any table/log/audit-metadata/URL/browser storage, and falls out of scope when the request completes.

## Tenant isolation (spec 70-72)

FDH-5 introduces no new table and no new FK relationship — every write goes through the SAME `fdh_statement_uploads`/`fdh_transactions`/`fdh_reconciliation_results`/etc. tables R7 already hardened (migration 0064's `r7_assert_*` triggers and engine-authoritative-insert-only triggers, both of which this migration's `create or replace function r7_assert_statement_upload_authoritative_fields()` extends to cover the 3 new FDH-5 columns). Every PDF service function takes an already-authenticated `userId` and re-scopes every service-role write with `.eq('user_id', userId)`, mirroring `bankCsvProcessingService.ts`'s own carve-out discipline exactly (see that file's header comment, reused verbatim in `bankPdfProcessingService.ts`'s own). Live adversarial proof: FDH5_SECURITY_CERTIFICATION.md / FDH5_LIVE_DEV_CERTIFICATION.md.

## Admin access (spec 74)

No raw-PDF admin viewer, no extracted-statement admin viewer, no debug download route, and no new admin route of any kind is introduced by FDH-5. `lib/financial-data-hub/constants/adminBoundary.ts`'s `ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS` is an allowlist — the 3 new `fdh_statement_uploads` columns (`page_count`, `pdf_classification`, `extraction_confidence`) are invisible to any future admin surface until someone deliberately adds them there; FDH-5 makes no such addition.

## Malware / AV residual (spec 80)

Unchanged from FDH-3: no antivirus/malware scanner is integrated. PDF structural validation (magic bytes, encryption detection, page-count/size bounds) is explicitly **not** malware scanning. This residual is carried forward, not newly introduced or newly claimed resolved by FDH-5 — see FDH5_COMPLETION_REPORT.md §19 Open Residuals.
