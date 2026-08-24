# FDH5-A — Reuse and Gap Audit

Starting point: canonical `origin/main` at `e143d6dc4cc40bc7f17c01f86cb0afa0a42de24f` (verified via `git fetch && git log origin/main`), which includes FDH-3, R7, FDH-4 and R8 all merged. Latest migration on this SHA: `0068_r8_transaction_classification_engine.sql`.

During implementation, canonical `main` moved further (R9 merged, new tip `ddfc19e723cb6bb2472565607b001d7d12096d6d`, adding migration `0069_ii_r9_review_items_authoritative_write_hardening.sql`). This branch was **not** rebased mid-implementation (see FDH5_COMPLETION_REPORT.md §0 for the reasoning); `e143d6d` remains the documented starting point per spec section 4.

## Migration numbering

Local guard (`check-migration-versions.mjs`) reported "next version 0069" from this branch's own migrations folder alone. Cross-branch guard (`check-migration-versions-against-branch.mjs`) against both `origin/main` and the still-unmerged `doclife/feature/investment-intelligence-r9-goals-forecasting-review` branch reported zero collisions at that number. Neither check alone was sufficient: live DEV's REST OpenAPI schema (`/rest/v1/`) was queried directly and showed 11 tables (`forecast_runs`, `forecast_profiles`, `forecast_scenarios`, `forecast_results`, `forecast_assumptions`, `forecast_explanations`, `forecast_global_assumptions`, `forecast_report_render_tokens`, `goal_forecasts`, `ii_goal_allocations`, `user_goals`) that exist live but appear in **no** migration file committed to any branch at the time of the check — proof a migration numbered beyond `0067` was already applied to DEV. `0070` was allocated as the next verified-free number. Canonical main's subsequent merge of R9 (which turned out to allocate exactly `0069` for that same content) confirms this allocation was correct.

## Existing capability inventory

| Capability | Location | FDH-5 disposition |
|---|---|---|
| Secure upload / private storage | `lib/financial-data-hub/services/uploadLifecycle.ts`, `storage.ts` (FDH-3) | Reused unchanged, except one narrow, spec-authorised change to the password-required branch (see below) |
| PDF magic-byte + encryption detection | `lib/financial-data-hub/domain/fileValidation.ts` (FDH-3) | Reused unchanged |
| `fdh_source_types` lookup already includes `pdf_native`/`pdf_scanned` | migration 0045 (FDH-1) | Reused unchanged — no migration needed for this |
| `fdh_transactions.source_page` / `extraction_confidence` | migration 0047 (FDH-1) | Reused unchanged — FDH-1 had already anticipated PDF provenance |
| `fdh_statement_uploads.processing_method` incl. `native_text`/`ocr`, `error_code` incl. `password_required`/`password_invalid` | migration 0046 (FDH-1) | Reused unchanged |
| `fdh_reconciliation_results.opening_balance`/`reported_closing_balance` | migration 0048 (FDH-1) | Reused unchanged |
| Parser registry (`fdh_parser_registry`/`fdh_parser_versions`) | migration 0045 (FDH-1) | Extended (new `source_format='pdf_native'` rows + `certified_extraction_methods` column), not replaced |
| CSV parsing/detection/normalisation | `lib/financial-data-hub/bank-csv/*` (R7/FDH-4) | Untouched except two additive, backward-compatible extensions: `dateFormats.ts` gains 2 month-name formats, `normalize.ts` exports `inferTypeHint` (was already private, pure, source-agnostic) |
| Deterministic dedup (fingerprint + decision) | `bank-csv/fingerprint.ts`, `bank-csv/dedup.ts` | Imported and called **unchanged** from the PDF orchestrator — zero new dedup logic |
| Reconciliation engine | `bank-csv/reconciliation.ts` | Imported and called **unchanged** |
| Certification decision | `bank-csv/orchestrator.ts`'s `decideCertification` | Imported and called **unchanged** (PDF status values are mapped onto the CSV-shaped input before the call) |
| R8 categorisation/merchant intelligence | `lib/financial-data-hub/classification/*`, `services/transactionClassificationService.ts` | Reused via the existing `POST /bank-transactions/categorise` route, which already operates over ALL of a user's canonical transactions with zero source-type awareness — verified directly against R8's own source (no `source_type`/`processing_method`/format field exists in `classifyTransaction()`'s input shape) |
| Server-side PDF text extraction | `pdf-parse` (already a dependency, already used by Investment Intelligence R2 — `lib/services/investment-intelligence/pdfExtraction.ts`) | Reused the SAME package (no new dependency); FDH-5 writes its own thin, page-segmented wrapper (`bank-pdf/textExtraction.ts`) rather than modifying R2's already-certified module or importing across the II/FDH boundary — see FDH5_PDF_ARCHITECTURE.md |
| Admin operational-metadata boundary | `lib/financial-data-hub/constants/adminBoundary.ts` (FDH-1) | Untouched — an allowlist model, so FDH-5's 3 new `fdh_statement_uploads` columns are invisible to any future admin surface by default, with zero code change required |

## Reuse Matrix (spec section 12)

| Component | Origin | Disposition | Extension |
|---|---|---|---|
| Secure upload | FDH-3 | Reuse | None |
| Private storage | FDH-3 | Reuse | None |
| CSV parsing | R7/FDH-4 | Reuse | None |
| Canonical transactions | FDH-1 | Reuse | PDF mapping only (via `bankPdfProcessingService.ts` inserting into the SAME table/columns) |
| Dedup | R7 | Reuse | None (byte-identical function calls) |
| Reconciliation | R7 | Reuse | Provenance input only (PDF-extracted rows feed the same function) |
| Categorisation | R8 | Reuse | Handoff only, via the existing generic endpoint |
| Merchant intelligence | R8 | Reuse | Handoff only |
| PDF extraction | none | **New** | `lib/financial-data-hub/bank-pdf/*` |
| OCR | none | **New (architecture only)** | `bank-pdf/ocr.ts` — no live provider call in this phase (see FDH5_OCR_ARCHITECTURE.md) |

**Duplicate downstream engines introduced: 0.**

## One deliberate, spec-authorised change to existing FDH-3 code

`lib/financial-data-hub/services/uploadLifecycle.ts`'s `completeUpload()` password-required branch previously set `processing_status: 'rejected'` (terminal) for any password-protected PDF — despite the function's OWN header comment already promising "queued so a future FDH-4/5 parser can ask the user for the password". Spec section 22 explicitly authorises FDH-5 to close this gap: the branch now transitions to `'queued'` (an already-legal FDH-1 lifecycle edge) with `error_code: 'password_required'`, so a later `processBankPdfDocument(userId, documentId, password)` call can attempt a transient, in-memory decrypt. No password is stored at any point in this change. See FDH5_PASSWORD_PROTECTED_PDF.md.

## Gaps genuinely requiring new code

1. PDF structural classification (TEXT_NATIVE/IMAGE_ONLY/MIXED_CONTENT/ENCRYPTED/CORRUPT/UNSUPPORTED) — none existed.
2. Page-segmented native text extraction — R2's extractor collapses to one string; FDH-5 needs per-page text for provenance and page-break handling.
3. Row reconstruction from linearised PDF text — none existed.
4. PDF bank-adapter registry/detection — none existed (parallel to, not replacing, the CSV registry).
5. PDF-specific normalisation glue (`bank-pdf/normalize.ts`) — thin, reuses every actual primitive from `bank-csv/*`.
6. Password transient-processing + rate limiting — FDH-3 only detected encryption.
7. OCR fallback contract (types/routing only, no live call — see FDH5_OCR_ARCHITECTURE.md for why).

None of these six duplicate an existing engine; all six are new PROVENANCE/EXTRACTION work exactly as spec section 3 scopes FDH-5's ownership.
