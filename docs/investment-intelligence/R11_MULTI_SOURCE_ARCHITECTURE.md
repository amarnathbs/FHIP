# R11 Multi-Source Architecture

Companion to `R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md`. Describes how the three in-scope sources (CAMS, KFintech, manual import) contribute to one canonical truth.

## Layers, and which layer R11 actually touches

| Layer | Owner | Source-agnostic already? | R11 change |
|---|---|---|---|
| `ii_accounts` (folio/account identity) | R1 `accountResolution.ts` | **Yes** — keyed on `(user_id, institution_name, normalised folio_number)`, no `source_key` in the match key | None — reused as-is |
| `ii_instruments` (scheme/ISIN identity) | R2 `schemeResolution.ts` | **Yes** — keyed on ISIN/AMFI code/normalised name, no `source_key` | None — reused as-is |
| `ii_transactions` (canonical ledger) | R1/R2 `documentProcessing.ts` | **No** — `fingerprint.ts`'s dedup fingerprint embeds `source_key` as its first component by design (correct for same-source re-import idempotency, wrong for cross-source identity) | **New**: a second, cross-source identity check (`crossSourceIdentity.ts`) runs after the existing fingerprint check, only when the fingerprint check finds nothing |
| `ii_holding_snapshots` → `ii_fhip_publications` (net worth) | R3 `investmentPublicationService.ts` | **Yes** — the "active publication" lookup is keyed on `(account_id, instrument_id)`, superseded by statement `as_of_date` freshness via `decideRefreshSupersession`, never by source or import order | None — reused as-is; regression-tested (`iiR3NetWorthCertification.test.ts`, `iiR3DedupScenarioMatrix.test.ts` both pass unchanged) |
| R4 performance / R5 SIP-XRay / R6 tax | `analyticsRepository.ts` / `r5Repository.ts` / `taxRepository.ts` | N/A (consumers, not producers) | **New**: the existing `status !== 'reversed'` exclusion filter (R2's), pre-existing in all three files, extended to also exclude `status !== 'review_required'` — an additive input-selection change, not an algorithm change |

## Why this is a narrow, evidenced change, not a rewrite

Two of the four layers that determine "does this evidence get counted twice" were already source-agnostic before R11 started — this was verified by reading `accountResolution.ts`, `schemeResolution.ts`, and `investmentPublicationService.ts`'s active-publication lookup directly, not assumed. The actual gap was narrow: one hash function (`computeTransactionFingerprint`) and one partial unique index (`uidx_ii_transactions_fingerprint`) that are *correctly* source-scoped for their original R2 job (same-document re-import idempotency) but were never extended to also catch cross-document, cross-source duplication. R11 adds a second, independent check rather than modifying the first — this is deliberate: the R2 fingerprint mechanism's own certified behaviour (`iiR2Dedup.test.ts`, `iiR2Fingerprint.test.ts`) is completely untouched and re-verified passing.

## New write path (documentProcessing.ts)

```
parse transaction candidate
  → compute R2 fingerprint (unchanged)
  → same-source exact fingerprint match? → link, done (unchanged R2 path)
  → NEW: load other-source candidates for (account_id, instrument_id)
      → resolveCrossSourceTransactionMatch(candidate, candidates, config)
        EXACT / HIGH_CONFIDENCE → link via ii_transaction_source_links
                                   (match_basis='cross_source_exact'|'cross_source_high_confidence'),
                                   auto-resolved ii_reconciliation_cases row,
                                   NO new ii_transactions row
        CONFLICT / AMBIGUOUS    → INSERT the new row anyway (never discard evidence),
                                   status='review_required' (excluded from R4/R5/R6),
                                   open ii_reconciliation_cases row (status='open')
        NONE                    → INSERT normally, status='parsed' (byte-identical to pre-R11 behaviour)
```

The `crossSourcePositionCache` in `documentProcessing.ts` is invalidated after every insert within the same import batch, so a second transaction in the SAME statement against the SAME position correctly sees the first one as a candidate too (verified by code inspection; not separately unit-tested due to the DB-dependency of `documentProcessing.ts` — see `R11_TESTING_AND_VERIFICATION.md`'s disclosed gap).

## What was deliberately NOT built

- No new XIRR/TWRR/tax engine — R4/R6 algorithms are byte-identical; only their input `WHERE` filter gained one additional excluded status value.
- No parser for NSDL/CDSL/broker/MFCentral — `ii_sources.parser_available` remains `false` for all four; deferred per `R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md` section 2.
- No new correction/provenance table — `ii_transaction_source_links` and `ii_reconciliation_cases` (both R2) are extended, not duplicated.
