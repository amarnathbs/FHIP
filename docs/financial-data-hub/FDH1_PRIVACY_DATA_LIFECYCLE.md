# FDH-1 — Privacy & Data Lifecycle

**FDH-1 implements no purge worker and no document vault.** What it guarantees
is that the schema cannot *block* the approved retention model, and that the
database will refuse to record a purge that did not actually happen.

---

## 1. The retention principle

Once a user has **approved** a processed document, the raw source material is
deleted and only privacy-safe derived facts are kept.

| Deleted after approval | Retained |
| --- | --- |
| The uploaded original document | Transaction date |
| Any decrypted temporary file | Amount and currency |
| Page images | Clean description |
| OCR artefacts | Normalised merchant (`merchant_id`) |
| Unnecessary personal identifiers | Economic type |
| Raw sensitive narratives, once no longer needed | Category / subcategory |
| The original filename | Source institution |
| | Privacy-safe account fingerprint |
| | Provenance (which document, which parser version) |
| | The user's own corrections |

## 2. Where each purgeable value lives

| Column | Table | Class | Purge action |
| --- | --- | --- | --- |
| `raw_document_storage_reference` | `fdh_statement_uploads` | STD | set null |
| `original_filename_sanitised` | `fdh_statement_uploads` | STD | set null |
| `description_raw` | `fdh_transactions` | STD | set null once `description_clean` exists |
| `merchant_raw` | `fdh_transactions` | STD | set null once `merchant_id` is resolved |

**Every one is nullable, and `tests/unit/fdh1SchemaContract.test.ts` parses the
migration SQL and fails if any of them is ever declared `not null`.** A schema
that required a raw description would make the approved privacy model
impossible, and that failure mode would be silent — hence the test.

`lib/financial-data-hub/domain/privacy.ts` also declares
`PURGE_RETAINED_TRANSACTION_COLUMNS` explicitly, so a future purge
implementation cannot quietly widen its blast radius past the four columns
above.

## 3. Account identifiers

There is **no `full_account_number`, `bsb`, `ifsc` or `iban` column anywhere in
the FDH schema.** Two columns carry account identity, and neither is reversible
to a full number:

**`masked_identifier`** — a display remnant. Guarded at the database by
`chk_fdh_accounts_masked_identifier`:

```sql
check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}')
```

Any run of seven or more consecutive digits is rejected. An AU BSB+account
(6+9 digits) and an Indian account number (11–18 digits) cannot be stored;
`****1234` and `XXXX-4321` can. The same rule is mirrored in
`fdhMaskedIdentifier` so a caller gets a clear validation error rather than a
constraint violation.

**`account_fingerprint`** — reserved for a future **non-reversible deterministic
identifier**: a keyed hash (HMAC) of the normalised account number, so the same
account can be recognised across statements without the number ever being
stored.

> **FDH-1 does NOT implement this and does NOT populate the column.** No
> key-management or HMAC infrastructure exists anywhere in this repository
> today, and inventing one inside a foundation phase would be worse than
> deferring it. The column exists, is unique per user where present, and is
> unpopulated. The validation schema deliberately **refuses to accept a
> fingerprint from a caller** — a client-supplied fingerprint could be used to
> forge a collision with another account.

Any genuine temporary need for a full identifier during parsing belongs to
**FDH-3**'s secure processing lifecycle, in memory, and not to a persisted
column.

**FDH-1 introduces no new plaintext PII.**

## 4. Filenames

An uploaded filename is attacker-controlled and frequently carries the account
holder's name. FDH treats it three ways:

1. **Rejected, not stripped**, if it contains a path separator, a `..` traversal
   sequence, or a control character (`fdhSanitisedFilename`). A lossy cleaner
   invites double-encoding.
2. **Purgeable** — nulled by the purge patch.
3. **Never admin-visible** — excluded from the operational-metadata allowlist,
   with the reason recorded in `constants/adminBoundary.ts`.

## 5. Database-enforced purge integrity

Two check constraints turn the purge contract from a promise into a rule:

```sql
constraint chk_fdh_uploads_purged_reference
  check (raw_document_purge_status <> 'purged'
         or raw_document_storage_reference is null),

constraint chk_fdh_uploads_purged_at
  check (raw_document_purged_at is null
         or raw_document_purge_status = 'purged')
```

The first is the important one: **a row cannot claim to be purged while still
pointing at a document.** A purge implementation that deletes the bytes but
forgets to clear the pointer, or clears the status but not the pointer, fails
loudly at the database instead of leaving a reachable document behind a
"purged" label.

`buildStatementUploadPurgePatch()` produces a patch that satisfies both, and
`buildTransactionPurgePatch()` clears exactly the two raw transaction strings
and nothing else — asserted by test.

## 6. Purge ordering and safety

`isPurgeEligible(processing_status)` returns true **only** for `approved`.
Purging earlier would destroy the evidence the user is still being asked to
check.

`isTransactionSafeToPurgeRaw()` refuses to null a raw description before
normalisation has produced something to keep:

| `description_clean` | `merchant_id` | `merchant_raw` | Safe? |
| --- | --- | --- | --- |
| null | null | null | **no** — nothing retained |
| whitespace | null | null | **no** |
| "Groceries" | null | "SUPAMKT 1234" | **no** — merchant unresolved, raw still the only copy |
| "Groceries" | resolved | "SUPAMKT 1234" | **yes** |

## 7. Legal hold

`legal_hold` is a valid purge state, reachable only from `pending`, and
terminal. It is **structural only**: FDH-1 ships no service, route or UI that
can set it, and it must never become settable through an ordinary admin screen.
A hold mechanism needs its own approved design.

## 8. Data minimisation elsewhere in the schema

Beyond the four purgeable columns, three further decisions reduce what is stored
at all:

* **`fdh_review_items.context_json` is a closed `.strict()` shape with no
  free-text field.** It carries identifiers, check codes, counts and a
  confidence — nothing else. If free text were allowed, raw statement narrative
  would inevitably be stashed there and would survive the purge, quietly
  defeating the whole model. A test asserts a `{ raw_narrative: "VISA DEBIT
  PURCHASE ACME PTY LTD 1234" }` context is rejected.
* **`title_code` and `resolution_code` are machine keys**, not sentences
  containing merchant names or amounts.
* **`error_message_sanitised` and `details_sanitised` are bounded** and carry
  operator-safe text only; the machine-readable reason is the controlled error
  code.

## 9. Deletion semantics

Cascade behaviour is chosen per relationship, not applied uniformly — see
`FDH1_DATABASE_SCHEMA.md` §8. The one worth restating here:

**`fdh_transactions.statement_upload_id` is `on delete set null`, not
`cascade`.** A transaction must outlive its source document, because the purge
model deliberately removes the document while keeping the derived facts. A
cascade there would mean purging a statement silently deleted the user's
transactions.

## 10. What is deferred

| Item | Phase |
| --- | --- |
| Document vault / storage backend, signed URLs, upload | FDH-3 |
| Keyed non-reversible `account_fingerprint` derivation and key management | FDH-3 (earliest) |
| The purge worker itself | FDH-3 (earliest) |
| Retention-period policy (how long before `purge_due_at`) | Product Owner decision, FDH-3 |
| Legal-hold mechanism and its consent/authorisation model | Separate approved phase |
| Temporary consent-gated admin support access | Separate approved phase |
