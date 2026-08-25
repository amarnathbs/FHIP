# R11 Raw Document Governance

Spec section 7 (hard rule) and section 51.

## The model

User owns/controls access → the trusted server/processing service (`documentProcessing.ts`, already-existing R1/R2 architecture, service-role, invoked only from an already-authenticated user's own upload flow) may process authorised documents → a professional only ever sees data explicitly delegated by the user, and never the raw document.

## What R11 changes here: nothing to `ii_source_documents`/storage RLS

Migration `0078`/`0079` do not touch `ii_source_documents`' existing owner-only RLS policy (`"own ii_source_documents"`, migration `0032`, untouched) or the private-bucket storage object policies (FDH-3/R2 territory). No new table in R11 grants a professional or any other non-owner principal SELECT on `ii_source_documents` or the storage bucket.

## VIEW_RAW_DOCUMENTS does not exist

Not "defaults to not granted" — the scope literally is not a member of `PROFESSIONAL_SCOPES` (`lib/services/professional-access/permissions.ts`). `isRawDocumentScopeSupported()` returns `false` unconditionally. There is no code path in `checkProfessionalAccess`, no database column, no API route parameter that could ever request or grant it. Adding it would require a separate, explicitly-scoped future change — not a configuration flip.

## Verified, not merely asserted

- **NC7 negative control** (`R11_NEGATIVE_CONTROL_CERTIFICATION.md`): temporarily adding `VIEW_RAW_DOCUMENTS` to the scope vocabulary and flipping `isRawDocumentScopeSupported()` to `true` was proven to break 6 real tests, then reverted — proving the current absence is load-bearing, not incidental.
- **Structural**: every professional-facing read endpoint (e.g. `investments-summary`) uses `createAdminClient()` to read specific, named, structured columns from `ii_accounts`/`ii_holding_snapshots` — it has no code path that touches `ii_source_documents.storage_path` or calls `downloadSourceDocumentObject` (the one function in `storage.ts` capable of reading a raw document) at all.

## Any future break-glass access

R11 introduces no standing human-admin access to raw documents and no break-glass mechanism. Per spec section 7, any future support-access capability must be separately governed, time-bounded, and audited — R11 explicitly does not add it, silently or otherwise. `lib/services/adminAuth.ts`'s existing `requireAdmin()` plane (used for reference-data writes like `ii_sources`, `ii_source_precedence_policy`) is architecturally separate from and has no elevated read path into user-owned `ii_source_documents` rows introduced or altered by this release.
