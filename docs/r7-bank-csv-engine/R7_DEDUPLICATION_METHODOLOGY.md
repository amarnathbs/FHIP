# R7 — Deduplication Methodology

## Four layers (spec §32-36)

| Layer | Mechanism | Table/field | Purpose |
|---|---|---|---|
| 1 — source-document | `fdh_statement_uploads.file_hash` (SHA-256) + `duplicate_of_document_id` | FDH-3, reused as-is | "Was this exact file uploaded before?" — informational; Layer 3 is what actually prevents double-counted transactions |
| 2 — source-row | `computeSourceRowHash(statementUploadId, rowNumber, rawRowValues)` | `fdh_transactions.source_row_hash` | Retry-safety: the same statement re-processed yields the same row hash — used for idempotency, not user-facing dedup |
| 3 — economic identity | `computeEconomicFingerprint({financialAccountId, currencyCode, transaction})` | `fdh_transactions.economic_fingerprint` | The actual cross-import dedup mechanism |
| 4 — candidate review | `fdh_duplicate_candidates` | `dedup_status = 'duplicate_candidate'` | Weak-evidence matches, never auto-discarded |

## Economic fingerprint algorithm (`ECONOMIC_FINGERPRINT_VERSION = 'r7-fp-v1'`)

```
sha256(JSON.stringify([
  financialAccountId,               // spec §35 — account scope IS included (NC5)
  currencyCode,
  transactionDate, valueDate,
  amountOriginal.toFixed(4),
  creditDebit,
  descriptionClean.toLowerCase(),
  (referenceRaw ?? '').toLowerCase(),
  balanceAfter?.toFixed(4) ?? '',
]))
```

**Deliberately excludes** `statement_upload_id` / import batch (spec §35) — the same economic transaction re-imported from a different statement (overlap, re-export, renamed file) fingerprints identically, which is the precondition for cross-import dedup.

## Decision logic (`decideDedup()`, spec §33-34, §36)

A fingerprint match is downgraded from CONFIRMED to CANDIDATE unless **both** the new row and the previously-accepted row carry a reference number or a running balance ("strong evidence"). This is the direct fix for spec §33's requirement — two genuine same-day/same-amount purchases with no reference/balance are BOTH kept, flagged `duplicate_candidate`, never silently merged (certification cases R7-TC073, R7-TC080).

| `hasStrongEvidence` (new) | `hasStrongEvidence` (existing match) | Result |
|---|---|---|
| any | no match at all | `unique` |
| true | true | `duplicate_confirmed` (match_method `exact_hash`, confidence 0.99) |
| false or missing | true or false | `duplicate_candidate` (match_method `fuzzy_amount_date`, confidence 0.6) |

## Within-file duplicates (spec §68)

`dedup.ts`'s `DedupIndex` is a single `Map<fingerprint, entry[]>` populated BOTH from persisted prior transactions (loaded via `loadDedupIndexForAccount()`, paginated) AND from rows already accepted earlier in the same processing run (`addToDedupIndex()` called immediately after each row's decision) — one code path handles cross-import and within-file duplicates identically (R7-TC082).

## User resolution (spec §36, §54)

`fdh_duplicate_candidates.status: pending → confirmed_duplicate/not_duplicate`, mirrored onto both transactions' `dedup_status: duplicate_candidate → user_confirmed_distinct/user_confirmed_duplicate`. Enforced at the database as the ONLY legitimate `authenticated`-role transition on both columns (migration 0064 triggers) — see `R7_SECURITY_VERIFICATION.md`.

## Certified scenarios (spec §68, cases R7-TC077-R7-TC095)

Exact re-import (0 new transactions second pass) · same file renamed (byte-identical fingerprints) · overlapping statements (only the genuinely new rows counted) · two legitimate same-day/same-amount purchases (both kept, candidate) · same amount/date different reference (unique, no false match) · duplicate row duplicated within one CSV (caught) · reversal pair (never falsely deduped — opposite direction always fingerprints differently) · refund pair · two accounts with an identical transaction (NOT cross-matched — account-scoped fingerprint) · minor description-whitespace difference (still matches — normalisation-aware) · reordered rows (order-independent fingerprint set) · re-export with an added column (detection unaffected).

## Negative controls (spec §69, §73 — RED→GREEN, see `tests/unit/r7Deduplication.test.ts`)

- **NC1 (dedup)**: a deliberately weakened date+amount-only fingerprint (reimplemented inline in the test, not the production code) wrongly merges two genuine same-day purchases — RED (1 failure demonstrated). The production fingerprint correctly keeps them distinct — GREEN.
- **NC5 (account scope)**: a fingerprint omitting the account id wrongly collides the same transaction across two different accounts — RED. The production fingerprint (which always includes `financialAccountId`) correctly distinguishes them — GREEN.

Both negative controls are embedded directly in the vitest certification suite (R7-TC091-095) rather than as source-code mutation scripts, so the RED half re-implements the *weaker* logic inline for comparison rather than temporarily patching the shipped module — the GREEN half then re-asserts the real production behaviour immediately after, so both halves run in the same CI pass with no manual restore step.
