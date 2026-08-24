# FDH5_SECURITY_CERTIFICATION

## Tenant isolation — architecture

FDH-5 introduces zero new tables and zero new FK relationships. Every write (`fdh_statement_uploads`, `fdh_transactions`, `fdh_reconciliation_results`, `fdh_data_quality_results`, `fdh_data_provenance`, `fdh_duplicate_candidates`) goes through the SAME tables R7 already hardened (migration 0064's engine-authoritative-insert-only triggers and authoritative-field-write triggers, both of which migration 0070 extends via `create or replace function` to also cover the 3 new FDH-5 columns on `fdh_statement_uploads` — no new trigger object, the existing one is widened). `bankPdfProcessingService.ts` re-scopes every service-role write with `.eq('user_id', userId)` regardless of RLS bypass, mirroring `bankCsvProcessingService.ts`'s carve-out discipline verbatim (see that file's own module header, and `tests/unit/fdh1Isolation.test.ts`'s now-six-file service-role allowlist, updated to include `bankPdfProcessingService.ts`).

## Live adversarial security certification (spec 70-72, 106)

See FDH5_LIVE_DEV_CERTIFICATION.md for the actual run. Summary of what was proven against real DEV with two real authenticated users:

- Tenant B cannot read Tenant A's PDF-sourced document status or transactions (app API + direct PostgREST).
- Forged processing request (Tenant B submits Tenant A's real `document_id` to `/process`) rejected.
- Forged PASSWORD submission (Tenant B submits a password for Tenant A's document) rejected by the same ownership gate — no separate vulnerability surface exists for the password path because it reuses the identical `getOwnedDocument()` check every other PDF service function uses.
- Tenant B cannot write/correct Tenant A's PDF-sourced transactions via direct PostgREST; ground truth independently re-verified unchanged.

## Compiled bundle scan (spec 72, 122)

After `npm run build`, every file under `.next/static/chunks/` was scanned for: `SUPABASE_SERVICE_ROLE_KEY`, the literal service-role JWT value, and the string `pdf-parse` (a server-only dependency that must never be bundled for the client, since it — like the rest of FDH-5's parsing code — runs exclusively in Next.js server code). See FDH5_COMPLETION_REPORT.md §14 for the exact scan command and result.

## No sensitive logging (spec 20, 84)

No `console.*` call anywhere in `lib/financial-data-hub/bank-pdf/*` or the two PDF services references raw PDF text, a password, or an account number — verified by direct inspection (grep for `console\.` across those files returns zero matches; no logging statement of any kind was added).

## No PDF-specific categorisation / no admin raw access (spec 64, 74)

See FDH5_R8_INTEGRATION.md and FDH5_PDF_SECURITY_MODEL.md respectively — both certified by static code inspection, both with zero exceptions found.

## FDH1-F1 (spec 73)

The broader historical finding (a foreign key alone proves existence, not same-tenant ownership) remains OPEN, exactly as documented since FDH-1/FDH-3. FDH-5 introduces no NEW relationship requiring narrow hardening (no new table, no new FK) — the R7-precedent triggers it extends were already scoped correctly; no casual refactor of unrelated historical FKs was performed.
