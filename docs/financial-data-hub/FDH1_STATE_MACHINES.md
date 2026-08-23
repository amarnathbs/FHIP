# FDH-1 — State Machines

Every machine here is defined in three places that must agree:

1. the **database** enforces the vocabulary, via `check (x in (...))`;
2. `lib/financial-data-hub/domain/documentLifecycle.ts` enforces the
   **transitions**;
3. `lib/financial-data-hub/validation/documents.ts` enforces them again at the
   **application boundary**, so an invalid transition is refused before a query
   is built.

Both halves are needed: a check constraint cannot express "approved may not go
back to processing", and application code alone cannot stop a bad value being
written by a different code path.

**FDH-1 defines and validates these machines. It implements none of the
services that drive them** — no uploader, no extractor, no approval flow, no
purge worker. Those are FDH-3 and later.

---

## 1. Document processing lifecycle

`fdh_statement_uploads.processing_status`

```
                    ┌──────────┐
                    │ created  │
                    └────┬─────┘
                         ▼
                    ┌──────────┐
                    │ uploaded │
                    └────┬─────┘
                         ▼
                   ┌────────────┐
                   │ validating │──────────────┐
                   └────┬───────┘              │
                        ▼                      │
                   ┌──────────┐                │
      ┌───────────▶│  queued  │                │
      │            └────┬─────┘                │
      │                 ▼                      │
      │           ┌────────────┐               │
      │           │ processing │               │
      │           └────┬───┬───┘               │
      │                ▼   └──────────┐        │
      │          ┌───────────┐        │        │
      │          │ extracted │        │        │
      │          └────┬───┬──┘        ▼        ▼
      │               │   │   ┌─────────────────┐
      │               │   └──▶│ review_required │
      │               │       └────┬──────┬─────┘
      │               ▼            ▼      │
      │        ┌────────────────────┐     │
      │        │ ready_for_approval │◀────┘
      │        └────┬──────┬────┬───┘
      │             │      │    └──────────┐
      │             ▼      └────────┐      │
      │        ┌──────────┐         ▼      ▼
      │        │ approved │    ┌──────────────┐
      │        └────┬─────┘    │   rejected   │  (terminal)
      │             ▼          └──────────────┘
      │      ┌───────────────┐        ▲
      │      │ purge_pending │        │
      │      └───┬────────┬──┘        │
      │          ▼        │           │
      │     ┌────────┐    │           │
      │     │ purged │    │  (terminal)
      │     └────────┘    │           │
      │                   ▼           │
      │              ┌────────┐       │
      └──────────────│ failed │───────┘
                     └────────┘
```

**Allowed transitions**

| From | To |
| --- | --- |
| `created` | `uploaded`, `failed` |
| `uploaded` | `validating`, `failed` |
| `validating` | `queued`, `failed`, `rejected` |
| `queued` | `processing`, `failed` |
| `processing` | `extracted`, `review_required`, `failed` |
| `extracted` | `review_required`, `ready_for_approval`, `failed` |
| `review_required` | `ready_for_approval`, `rejected`, `failed` |
| `ready_for_approval` | `approved`, `review_required`, `rejected` |
| `approved` | `purge_pending` |
| `rejected` | — *(terminal)* |
| `failed` | `queued`, `rejected` |
| `purge_pending` | `purged`, `failed` |
| `purged` | — *(terminal)* |

**Design notes**

* `approved` is terminal for processing. The only onward move is into the purge
  lifecycle. A document cannot be un-approved back into `processing`, because
  approved data may already have been acted upon.
* `failed` is **recoverable** — a fixed parser or a supplied password re-queues
  the document. It is not recoverable *into approval*: `failed → approved` is
  refused. Correcting a failure means reprocessing, not waving it through.
* `rejected` is a **user** decision and is only reachable once there is
  something for the user to look at.
* Moving to `failed` **requires a controlled error code**
  (`fdhDocumentTransitionSchema`). A failure with no reason is not recordable.

## 2. Raw-document purge lifecycle

`fdh_statement_uploads.raw_document_purge_status`. Runs **alongside**, not
inside, the processing lifecycle — a document's metadata row lives on after its
raw bytes are gone.

```
  ┌──────────────┐        ┌─────────┐        ┌─────────────┐      ┌────────┐
  │ not_required │───────▶│ pending │───────▶│ in_progress │─────▶│ purged │
  └──────────────┘        └────┬────┘        └──────┬──────┘      └────────┘
                               │                    │              (terminal)
                               ▼                    ▼
                        ┌────────────┐         ┌────────┐
                        │ legal_hold │         │ failed │
                        └────────────┘         └───┬────┘
                         (terminal)                │
                                                   └──▶ pending / in_progress
```

* **Eligibility gate:** `isPurgeEligible(status)` returns true **only** for
  `approved`. Purging before approval would destroy the evidence the user is
  still being asked to check.
* `failed` is retryable — a transient storage error must not strand a document
  forever. `purge_attempt_count` and `last_purge_error_sanitised` record why.
* `legal_hold` is reachable only from `pending`, is terminal here, and is
  **structural only**: FDH-1 ships nothing that can set it, and it must never be
  settable through an ordinary admin UI.
* Moving to `purged` **requires a `purged_at` timestamp** and, at the database
  level, that `raw_document_storage_reference` is already null
  (`chk_fdh_uploads_purged_reference`). A row cannot claim to be purged while
  still pointing at a document.

## 3. Review item lifecycle

`fdh_review_items.status`

```
  open ──▶ in_progress ──▶ resolved
   │            │
   ├────────────┴────────▶ dismissed
   └─────────────────────▶ expired
```

`resolved` and `dismissed` require `resolved_at`
(`chk_fdh_review_resolved`).

**Persistence across import sessions is the important property here.** A
`missing_counterpart_account` item created when statement A was imported simply
stays `open`. It is not tied to a job, a session or a request, and nothing
expires it automatically. When statement B arrives weeks later, a future
matching engine (FDH-6) queries
`fdh_review_items(review_type, user_id) where status = 'open'` — an index that
exists for exactly this purpose — and can resolve it. The paired
`fdh_transaction_links` row carries a **null `transaction_id_to`** for the same
reason.

## 4. Ingestion job lifecycle

`fdh_ingestion_jobs.status`

```
  queued ──▶ running ──┬──▶ succeeded
     │                 └──▶ failed ──▶ (requeue while attempt < max_attempts)
     └──▶ cancelled                        │
                                           └──▶ dead_letter
```

Constraints: `attempt <= max_attempts`, `max_attempts >= 1`,
`completed_at >= started_at`. **No worker exists in FDH-1.**

## 5. Processing error taxonomy

Fourteen values, closed, enforced by `check` on both
`fdh_statement_uploads.error_code` and `fdh_ingestion_jobs.error_code`.

| Code | Meaning |
| --- | --- |
| `unsupported_file_type` | The file is not a format FDH accepts |
| `file_corrupt` | The file could not be opened |
| `password_required` | An encrypted PDF with no password supplied |
| `password_invalid` | The supplied password did not open the file |
| `institution_not_identified` | Could not determine which institution issued it |
| `document_type_not_identified` | Could not determine what kind of document it is |
| `parser_not_found` | No registered parser covers this institution/type/format |
| `layout_unsupported` | A parser exists but this layout variant is not supported |
| `extraction_failed` | The parser ran and could not produce usable rows |
| `reconciliation_failed` | Extracted rows do not agree with the reported balance |
| `data_validation_failed` | Extracted rows failed domain validation |
| `malware_detected` | The file was flagged by scanning |
| `privacy_purge_failed` | The raw document could not be deleted |
| `internal_error` | Anything else |

**Nothing else may ever be persisted.** A stack trace, an SQL error, a file
path or a library exception message must not reach the database or the user.
`error_message_sanitised` is bounded to 500 characters and is for a
user-safe/operator-safe sentence, not a dump.

`internal_error` is the catch-all precisely so that an unexpected exception has
a safe landing place and never tempts anyone to persist the raw message.

## 6. Master-data governance lifecycle

`fdh_merchants.verification_status` and `fdh_classification_rules.status`

```
  proposed ──▶ admin_review ──┬──▶ approved
                              ├──▶ rejected
                              └──▶ merged  (requires merged_into_merchant_id)
```

A separate workflow table was considered and rejected as unnecessary complexity
for a five-state lifecycle; the states live on the row, exactly as
`ii_instruments.status` already does.

**The rule this enforces:** a user correction never enters this machine
automatically. It cannot, because an ordinary session has no INSERT or UPDATE
policy on either table. Promotion is an administrator action.

## 7. Parser version lifecycle

`fdh_parser_versions.status`

```
  development ──▶ certified ──▶ deprecated ──▶ disabled
```

*Institution support is not one successful document.* A version stays
`development` until it has been certified against a real fixture set;
`fdhParserVersionSchema` refuses to mark a version `certified` without recording
when it entered service. Every processed statement retains both `parser_id` and
`parser_version_id`, so a later layout change is attributable and reprocessable
rather than silently corrupting old data.

FDH-1 contains **no parser**. The single fixture version in
`supabase/seed_fdh_test_fixtures.sql` is `development`, never `certified`.
