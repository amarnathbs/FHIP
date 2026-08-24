# FDH5_FINANCIAL_INTEGRITY_CERTIFICATION

Independent oracle discipline (spec 101): every expected value in this certification is computed by plain arithmetic in the TEST file itself, never by calling the engine under test to check its own homework.

## Monetary precision (spec 40) — `tests/unit/fdh5FinancialIntegrity.test.ts`

| Case | Result |
|---|---|
| AUD 0.01 | PASS — exact |
| AUD 0.10 | PASS — exact |
| AUD 999,999.99 | PASS — exact |
| INR 1,23,456.78 (Indian grouping) | PASS — exact, identical code path to Western grouping |
| INR 99,99,999.99 | PASS — exact |

## Reconciliation certification (spec 61-62, 91) — 3/3 cases

| Case | Expected | Result |
|---|---|---|
| Clean 3-row statement, running balance present | `reconciled`, closing = 1,234.56 (independent oracle: 1000 − 45.20 + 500 − 220.24) | PASS |
| 0.01 deliberate corruption on the last balance | `failed`, break detected at row 3 | **DETECTED** |
| One transaction deliberately omitted | `failed` (running-balance chain breaks) | **DETECTED** |

Missing opening/closing balance (spec 62): `bank-csv/reconciliation.ts`'s existing `not_available` semantics apply unmodified — no FDH-5 code path ever manufactures a reconciliation success from absent evidence (proved by construction: FDH-5 calls the reused function with real row data and never overrides its `status`, except the one disclosed downgrade case below).

**Statement-declared balance cross-check (new in FDH-5, spec 36 compliance).** When a PDF adapter's `metadataPatterns` explicitly extracts a printed "Opening/Closing Balance" line, `bankPdfProcessingService.ts` compares it against the rollforward-DERIVED balance from the reused `reconcileBalances()` using the same `moneyEquals()` utility that engine is built on — a mismatch downgrades an otherwise-`reconciled` status to `failed`. This is an ADDITIONAL data-quality check layered on top, not a second reconciliation engine (spec 60): it never runs its own arithmetic, only a comparison.

## Deduplication certification (spec 57-59, 68, 94, 102) — 3/3 cases + 1 idempotency case

| Case | Result |
|---|---|
| POSITIVE: identical statement reprocessed | `duplicate_confirmed` (fingerprint match with strong evidence on both sides) |
| NEGATIVE: two genuinely distinct same-day/same-amount/no-reference transactions | `duplicate_candidate` (flagged for review), **never** silently merged to `unique` count |
| CROSS-FORMAT: same economic transaction via PDF and via CSV | Identical `economic_fingerprint` (proven byte-equal); DIFFERENT `source_row_hash` (provenance from both documents genuinely distinguishable) |
| Idempotent reprocessing | Two independent extractions of the identical statement produce byte-identical fingerprints |

**Negative-control discipline (spec 102).** The dedup negative control above is not a trivial pass — it specifically proves the harness would catch a weak-fingerprint false-duplicate: two DISTINCT transactions with identical economic fingerprints (spec's own documented limit when no reference/balance evidence exists) are asserted to land on `duplicate_candidate`, and the test explicitly asserts the status is **not** `'unique'`, i.e. that they were not silently discarded as one fewer transaction — if `decideDedup` were ever weakened to auto-confirm on a bare fingerprint match, this test would fail.

## Row completeness (spec 91)

`fdh5AdapterCertification.test.ts`'s malformed-row case proves an unparseable block is reported (`unparseableBlocks`), not silently dropped from the returned counts — `bankPdfProcessingService.ts`'s `declared_row_count` includes `unparseableBlockCount`, so `declared != parsed` correctly forces `partial`/`review_required`, never a silent under-count masquerading as `certified`.

## Result

**Independent comparisons: 8/8 adapters × full round trip (detect → extract → normalise → reconcile), all PASS. Financial discrepancies: 0. Precision: PASS. Row completeness: PASS.**
