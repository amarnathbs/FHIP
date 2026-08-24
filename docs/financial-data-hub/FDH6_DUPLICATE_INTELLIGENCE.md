# FDH-6 — Duplicate Intelligence

## Verdict: fully owned by R7. Zero new FDH-6 code.

`docs/financial-data-hub/FDH6_R8_ADOPTION_AND_GAP_AUDIT.md` section 4 documents the investigation in full. Summary:

- `lib/financial-data-hub/bank-csv/fingerprint.ts` computes a Layer-3 ECONOMIC fingerprint (account + dates + amount + currency + normalised description + reference + balance) that deliberately excludes the import-batch id, so the same economic transaction re-imported via a different statement or a different FORMAT (CSV vs PDF) still collides.
- `lib/financial-data-hub/bank-csv/dedup.ts` classifies a fingerprint collision as `duplicate_confirmed`/`exact_hash` only when BOTH sides carry a distinguishing reference/balance ("strong evidence"); otherwise downgrades to `duplicate_candidate`/`fuzzy_amount_date` — never silently discards, never silently merges.
- `bankCsvProcessingService.ts` writes real `fdh_duplicate_candidates` rows.

## Why FDH-6 did not build a second, fuzzy amount+date duplicate layer

Spec section 31 explicitly asks FDH-6 to "first determine whether any additional economic duplicate layer is genuinely needed." It was evaluated and rejected: `fdh_transactions.transaction_date` is a `date` column (no time-of-day, by FDH-1's own explicit design choice — see migration `0047`'s header comment). Any duplicate matcher weaker than R7's existing fingerprint+evidence design (e.g. amount+date alone) cannot distinguish two genuine same-day purchases from a real duplicate at the granularity this schema stores — building one would systematically violate the spec's own mandatory negative control (section 33/74: "10:01 Coffee Shop $5.00, 14:22 Coffee Shop $5.00 — both are genuine, must remain two transactions") and trip spec section 136's FAIL condition ("legitimate transactions are destroyed as duplicates").

`tests/unit/fdh6IndependentCertificationPack.test.ts` section H (`[NC-Duplicate]`) proves this directly: a naive amount+date-only comparator WOULD call two genuine same-day coffees certain duplicates; the real `decideDedup()` correctly downgrades to a reviewable candidate instead.

## Duplicate type taxonomy mapping

| Spec section 32 concept | Existing mechanism |
|---|---|
| `DOCUMENT_REPROCESS_DUPLICATE` | `match_method = 'exact_hash'`, same statement re-parsed |
| `CROSS_FORMAT_DUPLICATE` | `match_method = 'exact_hash'` (strong evidence) or `'fuzzy_amount_date'` (weak evidence), CSV vs PDF — same economic fingerprint regardless of source format |
| `BANK_SOURCE_DUPLICATE` | `match_method = 'exact_hash'`, cross-import overlap |
| `POSSIBLE_ECONOMIC_DUPLICATE` | `status = 'pending'`, `match_method = 'fuzzy_amount_date'` |
| `NOT_DUPLICATE` | `status = 'not_duplicate'` (user resolution `kept_both`) |

No new enum values were needed — `FDH_DUPLICATE_MATCH_METHODS`/`FDH_DUPLICATE_STATUSES` (FDH-1) already cover every concept.

## Recurring is never duplicate

`recurringDetection.ts`'s grouping key requires a stable merchant/description identity across 2+ occurrences separated by a real cadence gap (7-365+ days depending on frequency) — structurally incompatible with `fdh_duplicate_candidates`' same-fingerprint-collision detection, which only fires for near-identical facts on effectively the same day. The two mechanisms never compete for the same transaction pair.
