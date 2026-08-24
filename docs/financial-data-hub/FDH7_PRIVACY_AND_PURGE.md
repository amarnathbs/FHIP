# FDH-7 — Privacy & Purge Integration

## Reused, unmodified (spec 97-101)

`services/purge.ts` and `domain/documentLifecycle.ts#isPurgeEligible`/`assertPurgeTransition` — zero lines changed by FDH-7. Purge eligibility remains `processing_status === 'approved'`.

## Disclosed, not silently patched (see `FDH7_REUSE_AND_GAP_AUDIT.md` Critical Finding 3)

Because FDH-7 deliberately does not repurpose `processing_status` (that would be a destructive change to R7/FDH-5's certified auto-progression), purge eligibility is **not** additionally gated on genuine user approval (`approved_by`). A "certified, clean" import can become purge-eligible via R7/FDH-5's existing auto-progression before a human has genuinely reviewed it. This is a **pre-existing** FDH-3/R7/FDH-5 gap, not introduced by this phase, and not fixed here — narrowing/fixing it would mean editing purge eligibility semantics shared by three already-certified phases, out of FDH-7's own narrow mandate. Recorded as an Open Residual for Product Owner decision.

## Structured data survives purge (spec 99-101)

Nothing added by FDH-7 depends on raw document availability: `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, `fdh_duplicate_candidates`, `fdh_transaction_corrections`, `fdh_approved_financial_summaries`, `fdh_document_audit_events` all reference `fdh_statement_uploads` (or nothing at all) — never the raw storage object. `review-summary`/`approved-summary`/`review-queue` all read structured rows exclusively; none of the three new routes reads `raw_document_storage_reference`.

## No new raw-document viewing (spec 25)

FDH-7 adds no document preview/viewer endpoint of its own — the existing `documents/{id}/preview` route (FDH-3) is unmodified and untouched.

## No admin raw access (spec 76)

Confirmed by the same grep sweep as `FDH7_SECURITY_MODEL.md`.

## User delete vs raw purge (spec 101)

FDH-7 preserves the existing distinction — `uploadLifecycle.ts#userDeleteDocument` (a user privacy action) and `purge.ts` (a retention-driven system action) remain the two separate mechanisms; FDH-7 introduces neither a third deletion path nor any conflation of the two.
