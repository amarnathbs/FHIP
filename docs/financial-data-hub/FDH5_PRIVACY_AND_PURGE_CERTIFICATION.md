# FDH5_PRIVACY_AND_PURGE_CERTIFICATION

## Privacy principle (spec 75)

Raw uploaded PDF statements are temporary processing artefacts; approved structured financial data (`fdh_transactions` and its provenance) is the durable record. FDH-5 introduces no new persistent-document concept — `fdh_statement_uploads.raw_document_storage_reference` (unchanged FDH-3 column) is the only pointer to raw bytes, and it is nulled by the SAME purge lifecycle (`services/purge.ts`, unmodified) R7/FDH-4/R8 already certified.

## Purge (spec 76-77)

`bankPdfProcessingService.ts` writes no new storage object and no new persistable artefact of any kind beyond the standard `fdh_statement_uploads` row + `fdh_transactions` rows + provenance/reconciliation/data-quality rows CSV already produces identically. `services/purge.ts` is called unmodified — FDH-5 adds zero purge-specific code. Live proof: FDH5_LIVE_DEV_CERTIFICATION.md's `FDH5-PURGE-01` — a real DEV document was approved, scheduled, and purged; the raw storage reference was independently confirmed nulled while `fdh_transactions` row count was independently confirmed unchanged before/after.

## Password after purge (spec 77)

There is nothing PDF-password-related to purge, because nothing password-related was ever persisted in the first place (see FDH5_PASSWORD_PROTECTED_PDF.md for the complete non-persistence proof — static code audit + live artifact-absence sweep). No password column, no password-shaped log line, and no password-shaped storage artefact exists anywhere for FDH-5 to purge.

## OCR artefact purge (spec 78)

Not applicable in this phase — no OCR call exists, so no OCR artefact (image, extracted-page file, temporary text, JSON result blob) is ever created. See FDH5_OCR_ARCHITECTURE.md. This is recorded here explicitly rather than silently, per spec 78's "no forgotten OCR artefact bucket" — there is no bucket because there is no artefact.

## Orphan detection (spec 79)

FDH-5 introduces no new storage path and no new temporary-artefact location, so `lib/financial-data-hub/domain/orphanDetection.ts` (unchanged) requires no extension — every PDF's raw bytes live at the SAME `fdh-source-documents/{user_id}/{document_id}/{document_id}.bin` convention CSV already uses, already covered by the existing orphan sweep.

## Structured data survives purge (spec 76, 107)

Certified live: `fdh_transactions`, `fdh_reconciliation_results` (and, by construction — same code path — `fdh_data_quality_results`/`fdh_data_provenance`) rows for the purged document were independently re-counted after purge and found unchanged.

## Privacy wording (spec 111)

The application's existing Privacy page was reviewed. Since no third-party OCR provider is integrated in this phase (FDH5_OCR_ARCHITECTURE.md), no wording update is REQUIRED to disclose external OCR processing — there is none. A future phase that DOES integrate a live OCR provider must revisit this page before that integration ships, per spec 111's own condition ("if a third-party OCR provider receives statement data, Privacy wording must explicitly reflect that").
