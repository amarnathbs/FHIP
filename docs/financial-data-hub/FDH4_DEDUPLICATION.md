# FDH-4 — Deduplication

Reused unmodified from R7 (`lib/financial-data-hub/bank-csv/dedup.ts`, `fingerprint.ts`). Full methodology in `docs/r7-bank-csv-engine/R7_DEDUPLICATION_METHODOLOGY.md`. No second dedup engine was built (spec section 20, hard architectural decision).

## Fingerprint fields (unchanged, restated for FDH-4's record)

`economic_fingerprint` = `financialAccountId, currencyCode, transactionDate, valueDate, amountOriginal.toFixed(4), creditDebit, descriptionClean.toLowerCase(), referenceRaw.toLowerCase(), balanceAfter.toFixed(4)`. No unstable database ID participates (spec section 54) — reprocessing the same file twice produces the same fingerprint. `statement_upload_id` deliberately excluded, so a duplicate is caught across separate uploads of overlapping statement periods, not just within one file.

## Strong-evidence gate (unchanged)

`hasStrongEvidence = Boolean(referenceRaw) || balanceAfter !== null`. Both true and false paths were exercised by the new adapters' fixtures this session: Macquarie has neither balance nor a populated reference on most rows (weak evidence by construction — its fixture never triggers auto-confirmed dedup), while ANZ/Axis/Kotak all carry balance (strong evidence).

## Negative controls this session (spec section 21)

`tests/unit/fdh4AdapterCoverage.test.ts` reuses R7's proven negative-control shape:
- **Same account, different transaction, same day** — not exercised as a fresh RED/GREEN pair (R7's own `R7-TC091/092` already cover this on the shared fingerprint code, which FDH-4 does not modify); re-running R7's existing suite (`tests/unit/r7Deduplication.test.ts`, 28 cases incl. 2 RED/GREEN pairs) confirms it still holds against the widened registry — **28/28 pass** (full regression, this session).
- **Cross-account non-duplication** (spec section 56) — same R7 suite, unmodified, still passing.
- **Reversal/refund non-collapse** (spec section 57) — direction (`creditDebit`) participates in the fingerprint; a purchase and its refund differ on that field and never collapse. Unchanged R7 behaviour, not re-derived by FDH-4.

## What FDH-4 verified live (new this session)

`scripts/fdh4_live_dev_certification.ts` (`FDH4-E2E-05`): the same CBA document processed twice via the real `/process` endpoint against real DEV produced **5 transactions both times** (not 10) — reprocessing idempotency proven live, not just in PGlite/vitest.

## Fingerprint privacy (unchanged, spec section 55)

`economic_fingerprint` is never returned by any API route FDH-4 touches (`/detect`, `/process`, `/reconciliation`, `/status` — all unmodified by this phase); it is an internal column, not serialised in any response payload inspected during live certification.
