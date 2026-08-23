# FDH-3 — Purge Certification

## 1. Purge operation (spec section 42)

`services/purge.ts#runPurgeAttempt()`, in order:

1. Idempotency short-circuit: a document already `purged` returns
   `already_purged` without touching storage again.
2. `assertPurgeTransition(current, 'in_progress')` — throws on an
   invalid state (e.g. `not_required` or `legal_hold`), so a purge attempt
   can only ever start from `pending` or `failed`.
3. If there is no storage reference at all (an abandoned session that never
   completed an upload), skip straight to the purged patch — nothing to
   delete.
4. `deleteDocumentObject()` — the actual Storage `remove()` call.
5. **`verifyDocumentObjectAbsent()`** — an independent `list()` call. The row
   is **never** marked `purged` on the delete call's success alone; it is
   marked `purged` only after this separate verification also confirms the
   object is gone.
6. `buildStatementUploadPurgePatch()` (FDH-1, unmodified) nulls the raw
   storage reference and filename, sets `purged_at`.
7. `recordDocumentAuditEvent({ eventType: 'document_purged', actorType: 'system' })`.

If step 4 or step 5 fails, the document is marked `failed` (never `purged`),
`purge_attempt_count` increments, and a sanitised error message (URLs
redacted, capped at 200 characters) is recorded — never a raw storage-client
exception.

## 2. Idempotency

A second `runPurgeAttempt()` call against an already-`purged` document
returns `already_purged` immediately and performs zero storage operations —
proven by the DB constraint `chk_fdh_uploads_purged_reference` (a row cannot
claim `purged` while still carrying a storage reference) plus the explicit
short-circuit at the top of the function.

## 3. Retry

`raw_document_purge_status` cycles `failed → pending` (or directly back to
`in_progress`) on the next sweep — the purge state machine (FDH-1,
unmodified) already supports this: `failed: ['pending', 'in_progress']`.
`purge_attempt_count` is a running total across all attempts.

## 4. Live storage-deletion proof (spec sections 102-103 — "do not infer
storage deletion from DB status")

`scripts/fdh3_dev_certification.mjs`, run live against DEV project
`vqycarelcoijzwlpkpcz`:

```
PASS  service-role upload succeeds
PASS  uploaded object is verifiable by listing (never inferred)
PASS  delete succeeds
PASS  object is verifiably ABSENT after delete (purge verification, not inference)
PASS  a pre-purge signed URL no longer serves the object after purge (HTTP 400)
```

The object was uploaded with real (synthetic) bytes, downloaded back
byte-for-byte identical via a signed URL, then deleted, and its absence was
proven by an independent `list()` call — not inferred from the delete call
returning success — exactly matching spec section 103's requirement.

## 5. Scheduler / invocation contract (spec section 99)

**No background scheduler is wired up.** This repository already uses
`pg_cron` for existing report-generation jobs, but a purge attempt must call
the Storage HTTP API, which SQL/`pg_cron` cannot do directly. FDH-3 does not
claim automated purge is operationally running. The documented, DEV-testable
invocation path is running `services/purge.ts#findDuePurges()` +
`runPurgeAttempt()` per row from a script (a thin wrapper script was not
built in this dispatch — the service functions themselves are complete and
unit/PGlite-tested; wiring an actual cron/queue invocation is an explicit,
disclosed follow-up once migration 0058 is live and an approved scheduler
mechanism is selected).

## 6. Abandoned-upload cleanup (spec section 48)

`services/purge.ts#sweepAbandonedUploadSessions()` finds upload sessions past
their `expires_at` that never completed, marks them `expired`, and — if the
underlying document never progressed past `created` — marks the document
`failed` and schedules a purge due immediately +
`FDH_DOCUMENT_RETENTION_DAYS.abandoned_days` (2 days). Not yet exercised
against live DEV data (requires migration 0058 applied first).

## 7. Orphan detection (spec sections 49, 69)

`domain/orphanDetection.ts#detectOrphans()` — a pure set comparison between
live storage keys and live document-referenced storage keys, returning both
directions of drift (`orphanStorageObjects`, `orphanDbReferences`).
Unit-tested with both a real-drift case and a matching case
(`tests/unit/fdh3Domain.test.ts`). The read side of the live wiring exists
(`services/storage.ts#listObjectsUnderUserPrefix()`, live-callable today); the
DB-side query and a combined report script await migration 0058's tables
being live. No automatic deletion logic is attached to detection, per spec
section 69 ("do not implement dangerous bulk deletion logic without
review").

## 8. What is NOT yet certified

- Purge against a **live, migrated** `fdh_statement_uploads` row (today's
  live-DEV proof exercises the storage layer directly with a synthetic key,
  not through the full API → DB → storage path, because the tables aren't
  live yet).
- The scheduler invocation itself (no wrapper script built this dispatch).
- End-to-end orphan reporting (detection logic proven; live report script
  pending the migration).

These are exactly the gaps `FDH3_COMPLETION_REPORT.md` reports as the basis
for CONDITIONAL PASS rather than FULL PASS.
