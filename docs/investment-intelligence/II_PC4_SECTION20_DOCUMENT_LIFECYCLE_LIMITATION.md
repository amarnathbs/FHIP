# PC4 Section 20 — Source document delete/reupload: known limitation

**Status:** documented only, per PC4 section 20's explicit instruction — no code
was built for this. This file exists purely to record the current behaviour so
it isn't rediscovered as a surprise later.

## What exists today

- `POST /api/investment-intelligence/source-documents` (`app/api/investment-intelligence/source-documents/route.ts`)
  uploads a new file. A byte-identical re-upload is deduplicated by checksum
  and simply returns the existing row unchanged. A *different* file (a
  corrected or re-exported version of the same statement) is always inserted
  as a brand-new, unlinked `ii_source_documents` row — there is no concept of
  "this replaces that document."
- **Reprocess** (`components/investment-intelligence/InvestmentIntelligenceClient.tsx`,
  `handleProcess`, calling `POST /api/investment-intelligence/source-documents/[id]/process`)
  lets a user re-run parsing against the *same already-stored bytes* of a
  document, optionally supplying a password. This re-derives transactions
  from the existing file — it cannot fix a wrong or corrupted upload, because
  the underlying bytes never change.
- The schema already has a `superseded_by_document_id` linkage
  (`lib/services/investment-intelligence/manualImporter.ts`), but it is only
  ever written by the manual/fixture importer path used for internal test data
  — no user-facing route or UI control sets it. It does not constitute a real
  reupload capability today.

## What does not exist

- No `DELETE` route for `ii_source_documents` (or anything under
  `app/api/investment-intelligence/source-documents/`).
- No UI control to remove an already-ingested statement.
- No supported way to replace a wrong/corrupted upload other than uploading
  it again as a second, unrelated document and manually working out which of
  the two the user should treat as authoritative — the product does not do
  this reconciliation for them.

## Why this matters

A user who uploads the wrong file, uploads a corrupted/partial statement, or
needs to correct a mistake (e.g. wrong account, wrong password unlocked a
different statement's pages) currently has no clean recovery path short of
contacting support for a manual database fix. This is a genuine gap in the
document lifecycle, not a cosmetic one — but per PC4's own scope boundary,
building delete/reupload/supersede UX is out of scope for this certification
pass. It should be scoped as its own follow-up (candidate for the LR-2..LR-12
"Unified Manual Input" or a dedicated Investment Intelligence lifecycle
phase), not folded into PC4.
