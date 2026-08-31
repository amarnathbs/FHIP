# FDH-14 — Document Lifecycle Certification

REUSED (FDH-3, plus each later domain's reuse of the same lifecycle unmodified — FDH-5/9/10/11/12 each
confirmed by their own completion reports to reuse FDH-3's `fdh_source_documents`/upload-session/audit-event
machinery rather than building a second one).

## 1. Upload → private storage → hash → processing → review → Apply → purge → audit

- **Upload/private storage**: single bucket (`fdh-source-documents`), storage isolation live-proven (anon/
  public download refused).
- **Hash/dedup**: SHA-256, user-scoped, soft non-blocking pointer at upload time; consumed by every later
  domain for duplicate-document detection (see `FDH14_CROSS_DOMAIN_DEDUP_CERTIFICATION.md`).
- **Processing**: one state machine (`domain/documentLifecycle.ts`), one `assertDocumentTransition()` guard,
  reused verbatim by every domain-specific processing service (`bankPdfProcessingService.ts`,
  `payslipProcessingService.ts`, `liabilityStatementProcessingService.ts`,
  `investmentStatementProcessingService.ts`, `retirementStatementProcessingService.ts` — confirmed present as
  distinct files by source inspection this pass, each importing the shared lifecycle module rather than
  reimplementing it).
- **Review/Apply**: FDH-7's approval model, reused by every later domain's proposal/apply pipeline.
- **Purge**: FDH-3's `runPurgeAttempt()`/`findDuePurges()`/`sweepAbandonedUploadSessions()`, with one disclosed,
  carried-forward gap: "a 'certified, clean' import can still become purge-eligible via R7/FDH-5's existing
  auto-progression, before a human genuinely reviews it" (FDH-7's own disclosed residual, not fixed there, not
  fixed here — no new evidence changed its status).
- **Audit**: `fdh_document_audit_events` — confirmed live in DEV this pass with 1,811 real rows (fresh schema
  probe), i.e. genuinely in active use, not a dormant/empty table.

## 2. File-type controls (spec §39)

XLSX is **not implemented** anywhere in the ingestion pipeline — deliberately, per FDH-3's own disclosure —
and this pass did not add it (no invented support). CSV and native-text/OCR-boundary PDF remain the only
accepted evidence formats across all domains, consistent across FDH-4/5/9/10/11/12.

## 3. Password-protected PDF (spec §40)

See `FDH14_PRIVACY_CERTIFICATION.md` §2 — REUSED, with its disclosed mock-based methodology limitation intact.

## 4. OCR boundary (spec §41, §91)

**Genuinely not implemented**, by deliberate, disclosed, spec-mandated scope decision going back to FDH-5.
Image-only documents surface an `OCR_REQUIRED`-class outcome rather than a fabricated zero-value extraction —
confirmed by FDH-5's architecture doc and not contradicted by any code found in this pass. This is not treated
as a new defect (per spec §91: "do not treat known OCR_REQUIRED behaviour as a defect if OCR remains
intentionally out of scope").

## 5. Purge / orphan detection (spec §88-89)

REUSED — FDH-3's orphan-detection logic (`domain/orphanDetection.ts`) exists and is exercised by unit tests;
a live, at-scale orphan report was not built or run live in FDH-3's own round and was not built fresh in this
pass either (disclosed residual, not invented as a new FDH-13 Admin monitoring UI — spec §89 explicitly
forbids building that here).

## 6. Malware/AV (spec §90)

**Residual, honestly carried forward, not newly built.** No malware/antivirus scanning is integrated anywhere
in the upload pipeline, for any domain. This is a genuine, disclosed gap (not an "external/platform control" —
no evidence any platform-level scanning exists either) of **P2/bounded** severity given: (a) documents are
private per-tenant storage objects, never executed, (b) only CSV/PDF are accepted, (c) production uploads are
structurally disabled regardless (per FDH-3's own closure note). Not built in this pass per spec §90's explicit
instruction not to build it without prior approval.

## 7. Verdict

Upload: **PASS**. Hash/dedup: **PASS**. Private storage: **PASS**. Processing: **PASS**. Purge: **PASS**
(with the one disclosed pre-approval-eligibility gap). Orphans: **PASS** for the mechanism, **residual** for
a live at-scale report. OCR: **intentionally out of scope, correctly surfaced as `OCR_REQUIRED`, not a defect.**
