# R11 Cross-Source Reconciliation

Implementation: `lib/services/investment-intelligence/crossSourceIdentity.ts` (pure, DB-free — mirrors the `reconciliation.ts`/`publicationLogic.ts` discipline). Orchestration: `documentProcessing.ts`. Persistence: `ii_reconciliation_cases` (R2, extended) + `ii_transaction_source_links` (R2, extended).

## States (spec section 32)

| State | Meaning | Canonical action |
|---|---|---|
| `exact` | Every deterministic field agrees, including a present-and-matching `source_reference` | Link as corroborating evidence, no new canonical row |
| `high_confidence` | Account/instrument/date/type/amount/units all agree; `source_reference` is absent on one or both sides so it cannot corroborate further | Link as corroborating evidence, no new canonical row |
| `conflict` | Core identity (account/instrument/date/type) agrees but amount/units disagree beyond tolerance, OR a present-and-disagreeing `source_reference` | Insert as a new row, `status='review_required'`, open `ii_reconciliation_cases` (never silently merged) |
| `ambiguous` | The candidate matches more than one existing row equally well (exact or high-confidence tied) | Insert as a new row, `status='review_required'`, open `ii_reconciliation_cases` |
| `none` | No shared core identity | Insert normally, `status='parsed'` — byte-identical to pre-R11 behaviour |

No fake confidence percentages anywhere — every state is a named, deterministic rule (spec section 29's explicit requirement), documented in code comments in `classifyPairwise()`.

## Field comparison detail (`compareCrossSourceTransactions`)

Compares exactly 7 fields: `accountId`, `instrumentId`, `transactionDate`, `transactionType` (exact string equality — these four are the "core identity" gate), `grossAmount`, `units` (tolerance-based, using the SAME `DEFAULT_RECONCILIATION_CONFIG.unitToleranceScaled`/`currencyToleranceScaled` values R2's `reconciliation.ts` already uses — `0.0001` units, `1.00` currency major unit, not a new/wider tolerance), `sourceReference` (exact match; both-null is reported as `matched: false` at the field level, but is handled specially at the state-classification level — see below).

All amount/unit comparisons use `lib/services/investment-intelligence/decimal.ts`'s exact scaled-`bigint` arithmetic — never floating point — reusing R2's own decimal module rather than a second parser.

## Every reconciliation decision is explained

Every case written to `ii_reconciliation_cases` carries (in `discrepancy_details`/`evidence` jsonb): which existing transaction(s) were compared (`comparedTransactionIds`), which fields matched (`matchedFields`) and differed (`differingFields`), a human-readable `rationale` string naming the specific transaction id(s) involved, and `engineVersion` (`r11-cross-source-identity-v1`, `CROSS_SOURCE_IDENTITY_ENGINE_VERSION`) — so a future engine change is distinguishable from a past decision, satisfying spec section 32's "which source prevailed, why, engine/rule version" requirement.

## Statement-date awareness (avoiding false conflicts)

`crossSourceIdentity.ts` operates on already-resolved `transaction_date` (the actual transaction's date, not the statement's `as_of_date`/coverage period) — two statements covering different periods but reporting the SAME transaction date/type/amount/units are correctly identified as the same fact (spec section 34's "different statement dates" caveat is about `as_of_date`, which never enters this function's comparison at all — it only matters at the holding-snapshot/net-worth freshness layer, which R3's `decideRefreshSupersession` already owns unchanged).

## Reimport idempotency and import-order independence

- **Reimport idempotency**: unaffected — the pre-existing R2 same-fingerprint check (untouched) still catches an identical re-import of the same document before the cross-source check is ever reached.
- **Import-order independence** (mandatory, spec section 37): `resolvePrecedenceWinner` (see `R11_SOURCE_PRECEDENCE_POLICY.md`) never uses array/processing order as a signal — proven by `PP-03`/`PP-04`/`PP-08` in `tests/unit/iiR11CrossSourceIdentity.test.ts`, and by negative control NC1 (see `R11_NEGATIVE_CONTROL_CERTIFICATION.md`), which sabotaged the function to return `candidates[0]` and confirmed 8 tests genuinely go red.

## Holdings-only sources never fabricate transaction history

R11 does not add any new path that derives `ii_transactions` rows from `ii_holding_snapshots` — the only transaction-creation path remains R2's statement-transaction-line parsing (`documentProcessing.ts` step 5) and the R1 manual importer. `crossSourceIdentity.ts` only ever COMPARES already-parsed transaction candidates; it has no holdings-to-transaction derivation capability to sabotage or misuse, which is why negative control NC4 was scoped, honestly, to the adjacent invariant this module DOES own (never treating a missing/incomplete `units` value as a match) rather than to holdings-derived-transaction fabrication, which is unchanged, already-certified R2 territory (`determineHistoryCompleteness` in `reconciliation.ts`).

## Incomplete acquisition history never fabricates tax basis

Unchanged from R2/R6: R11 adds no new tax-lot creation or cost-basis inference logic. A `review_required` transaction (cross-source conflict/ambiguity) is excluded from `taxRepository.ts`'s "usable" set entirely until resolved — it can never contribute a fabricated or partial cost basis while unresolved.

## R11-FINAL closure round: manual-importer cross-source gap found and fixed (2026-08-25)

A real live-DEV test (CAMS import first, then a manual-source fixture importing the SAME economic transaction second) found `manualImporter.ts` never called `resolveCrossSourceTransactionMatch` at all — it always inserted a fresh transaction row regardless of what a different source had already evidenced for the same position. This meant cross-source dedup only worked in the "CAMS/KFintech arrives second" direction; "manual arrives second" silently duplicated — a genuine import-order dependency (spec section 74 critical-fail class: "import order changes canonical truth"). Fixed by adding the identical cross-source check `documentProcessing.ts` already performs (same classification function, same exact/high-confidence-link-not-duplicate behaviour, same conflict/ambiguous-insert-as-review-required behaviour), using `fetchAllRows` for the candidate read (not a bare `.select()` — the R6-P0 pagination class applies here too). Reproduced live post-fix: CAMS-then-manual now correctly links rather than duplicating. See `R11_MANUAL_RECONCILIATION.md` MR13 and the final closure report for full detail.

## R11-FINAL closure round: pre-existing CAMS/KFintech parser AMC-name bug found and fixed (2026-08-25)

The SAME live test above initially failed for a different reason first: the CAMS-parsed account and the manual-fixture account resolved to two DIFFERENT `ii_accounts` rows for the identical (institution, folio) pair. Root-caused to a genuine, pre-existing (R2-era, predates R11) bug in `camsParser.ts`/`kfintechParser.ts`: `lastKnownAmcName` was only ever updated INSIDE the `if (schemeName !== null)` branch, but the local `amc` variable it read from was extracted fresh on each line — since "AMC Name:" and "Scheme Name:" are always on separate lines in every real statement, `amc` was `null` on the one line where `schemeName` was non-null, and `schemeName` was `null` on the one line where `amc` was captured — so `lastKnownAmcName` never actually updated from its initial `''`, and every parsed account/instrument silently carried a blank institution name. No existing golden-fixture test caught this because none asserted on the parsed `scheme.amcName`/downstream `institution_name` field specifically. Fixed in both parsers' `parseTransactions` and `parseHoldings` (4 occurrences) by capturing `amc` and updating `lastKnownAmcName` unconditionally on its own line. Full regression (2509/2509 non-skipped tests, including every R2 golden-fixture parser test) re-ran clean after the fix — confirming no certified fixture ever depended on the broken behaviour.
