# FDH5_PASSWORD_PROTECTED_PDF

**Particular scrutiny area (Product Owner instruction).** This document exists specifically to make the non-persistence claim checkable, not just asserted.

## Flow (spec 22)

1. Upload completes; FDH-3's existing byte-level encryption detector (`isPdfLikelyPasswordProtected`, unchanged) flags the file. `completeUpload()` now (FDH-5 change, see FDH5_REUSE_AND_GAP_AUDIT.md) transitions the document to `processing_status: 'queued'`, `error_code: 'password_required'` — a valid, retryable state, not a dead end.
2. Client calls `POST /api/financial-data-hub/bank-pdf/{documentId}/process` with `{ "password": "..." }` in the JSON **body** (never a query string — spec 23).
3. `processBankPdfDocument(userId, documentId, password)` checks `checkPasswordAttemptRateLimit()` (spec 24) using only already-persisted audit-event **timestamps**, then calls `runBankPdfPipeline({ ..., password })` exactly once.
4. `runBankPdfPipeline` -> `classifyPdf(bytes, password)` -> `extractPdfPages(bytes, password)` -> `new PDFParse({ data: bytes, password })`. This is the ONLY place the password value is ever used.
5. Wrong password: `PasswordException` thrown with `password` supplied -> classified `wrong_password` -> document returns to `'queued'` with `error_code: 'password_invalid'`, never `'failed'`/`'rejected'` (spec 24: "allow controlled retry").
6. Correct password: extraction proceeds; `pdf_decrypted_for_processing` audit event recorded (no password in its metadata); processing continues exactly as an unencrypted PDF would.
7. In every case, the `password` parameter and the string values inside `PDFParse`'s internal state fall out of scope (garbage-collection-eligible) the instant the one call returns — no code path anywhere in FDH-5 assigns it to a variable that outlives that single request handler's stack frame.

## Non-persistence — code-level proof

`tests/unit/fdh5ClassificationAndPassword.test.ts`'s "code-level password non-persistence audit" test statically scans every file under `lib/financial-data-hub/bank-pdf/`, the two PDF services, and the PDF API routes for the literal key `password:` inside any `metadata:` object or any `.insert(`/`.update(` payload object literal. **Zero matches** (assertion, not observation — the test fails if one ever appears).

Additionally: `bankPdfProcessingService.ts`'s own header comment documents, function by function, that `password` is referenced exactly once (the `runBankPdfPipeline` call) and nowhere else in that ~450-line file.

## Non-persistence — live DEV proof (spec 105-106, the scrutiny-area requirement)

See FDH5_LIVE_DEV_CERTIFICATION.md §"Live password case" for the actual live run: a real password value was submitted through the real `/process` API route against a real DEV user's document, then DEV's `fdh_statement_uploads`, `fdh_document_audit_events`, `fdh_transactions`, `fdh_reconciliation_results` rows for that document were fetched via REST and searched for the literal password string. **Zero occurrences** anywhere in any returned row.

## Rate limiting (spec 24)

`MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR = 8` (a documented, sensible per-document limit — not a cracking-resistant throttle; spec 24's "do not attempt cracking" is a statement about FDH-5's OWN behaviour, not a claim about resisting an attacker). Counted from `pdf_password_required` audit events in the trailing rolling hour for that specific document. Certified in `tests/unit/fdh5ClassificationAndPassword.test.ts` (allows-under-ceiling, refuses-at-ceiling, stale-attempts-excluded, unrelated-events-ignored — 4 cases).

## Decrypted-copy discipline (spec 25)

No decrypted PDF copy is ever written to storage or disk. `PDFParse({ data, password })` decrypts entirely in the Node process's memory (pdf.js's own in-memory handling — no temp file is created by this library for this call shape); `parser.destroy()` runs in a `finally` block on every path (success, wrong password, corrupt), so no library-internal state survives a failed attempt into a retry.

## Test methodology limitation, disclosed (spec 137)

Genuinely encrypting a PDF's content stream (RC4/AES per the PDF standard security handler) was **not** hand-rolled for unit testing — this repository's own established precedent (`tests/unit/iiR2PdfExtraction.test.ts`) already made and documented this exact call for Investment Intelligence R2, for the same dependency. `password_required`/`wrong_password` classification is certified via a controlled mock of `pdf-parse`'s real `PasswordException` type (proving FDH-5's OWN routing logic), not via a genuine encrypted binary round-trip. This is why the live-DEV proof above is deliberately framed as an **artifact-absence** proof (the property that actually matters per spec 23) rather than a claim of having exercised genuine binary decryption live.
