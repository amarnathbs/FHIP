# FDH-3 — Privacy & Retention

## 1. The approved principle

> Once the user has reviewed and approved the extracted financial
> information, the underlying uploaded financial document must be deleted
> according to the approved retention lifecycle. FHIP retains only the
> structured financial data and descriptions genuinely required for the
> user's financial profile and audit/provenance purposes.

Raw user financial documents are **temporary processing artefacts**, not
permanent financial records. FDH-3 implements no indefinite storage path.

## 2. Retention configuration (spec sections 39-40)

One place, `lib/financial-data-hub/constants/retention.ts` —
`FDH_DOCUMENT_RETENTION_DAYS`:

| Branch | Days | Rationale |
| --- | --- | --- |
| `approved` | 7 | A grace window, not instant deletion (spec: "do not overpromise immediate deletion") |
| `rejected_or_failed` | 1 | Nothing further will ever be done with this file |
| `abandoned_days` | 2 | An upload session that never completed |

User-initiated delete (spec section 47) schedules purge **immediately**
(`raw_document_purge_due_at = now()`), satisfying "near-immediate" directly
rather than through the 1-day constant — the constant governs *automatic*
rejection/failure, not an explicit user action.

These are FDH-3 defaults, not a final legally-reviewed retention policy —
exactly the boundary the spec draws: a real product decision on precise
durations belongs to a later, explicitly product-reviewed pass. What matters
structurally is satisfied now: every branch has a **finite** due date.

## 3. What survives a purge (spec sections 44-46)

`domain/privacy.ts#buildStatementUploadPurgePatch()` (FDH-1, unmodified) nulls
exactly two columns: `raw_document_storage_reference` and
`original_filename_sanitised`. Everything else on the row survives —
`document_type`, `institution_id`, `country_code`, `source_type`,
`file_hash`, timestamps, and the processing/quality/reconciliation status
columns — because FDH-3 implements no extraction, so there is no structured
financial data yet for a later purge to have to distinguish from raw content.
A future extraction phase (FDH-4+) will define its own purge patch for
whatever raw fields IT introduces, following this same pattern.

**File-hash privacy review (spec section 46):** `file_hash` is retained after
purge. Decision: it is needed for duplicate-detection across a user's own
future uploads (spec section 21) and is scoped per-user (never queried
cross-tenant, and not part of the admin operational-metadata allowlist — see
`constants/adminBoundary.ts`, which explicitly forbids `file_hash`: "permits
confirming whether a specific known document was uploaded"). A keyed
per-household digest was considered and rejected as premature: no HMAC
key-management infrastructure exists in this repository yet (the same
constraint that leaves `account_fingerprint` unpopulated since FDH-1) — see
`FDH1_PRIVACY_DATA_LIFECYCLE.md` section 3.

## 4. Purge state machine (reused from FDH-1)

`not_required → pending → in_progress → purged`, with `failed` retryable back
to `pending`/`in_progress`, and `legal_hold` reachable only from `pending`
but **not settable by anything FDH-3 ships** — reserved structurally for a
future, separately-approved hold mechanism. See `FDH3_PURGE_CERTIFICATION.md`
for the live proof.

## 5. Admin access (Product Owner Decision 3)

No admin route, page or service anywhere in the application reads a raw
document, a storage key, a filename, or a file hash. Admins may see only the
`ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS` operational-metadata projection
(unchanged set of concerns from FDH-1, widened only by 5 harmless new
timestamp columns — see `FDH1_RLS_SECURITY.md` and this phase's
`constants/adminBoundary.ts` diff). `fdh_upload_sessions` and
`fdh_document_audit_events` are both listed in
`ADMIN_NO_STANDING_ACCESS_TABLES` — no admin projection exists for either.
Mechanically enforced by `tests/unit/fdh1Isolation.test.ts`'s admin-boundary
describe block, including a new test that greps the entire admin surface
(`app/api/admin`, `app/(app)/admin`) for any FDH reference at all (zero
found).

## 6. Upload/privacy UX copy (spec sections 36, 72-73)

- Upload page (`app/(app)/financial-data-hub/page.tsx`): explains what can be
  uploaded, what happens next (upload → secure processing → review → approval
  → raw-document deletion), and states plainly that the document is private,
  not routinely admin-visible, and scheduled for deletion per FHIP's
  retention policy after approval — without claiming instant deletion.
- Privacy page (`app/(marketing)/privacy/page.tsx`): a new "Financial
  document uploads" section added between the existing "Third-party sign-in"
  and "Data control" sections, preserving all existing wording (this page is
  explicitly marked draft/pending-legal-review, so a narrowly-scoped addition
  was appropriate rather than a rewrite).
