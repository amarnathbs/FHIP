# R7 — Reconciliation Methodology

## Balance rollforward (`reconcileBalances()`, spec §42-43)

For the set of NON-duplicate-confirmed accepted transactions, sorted by `sourceRowNumber` (the statement's own print order — the only order a running balance is meaningful in):

1. **Row-level continuity**: for every consecutive pair of rows that both carry a balance, `prevBalance + signedAmount(row) == row.balance` (exact, via `lib/financial-data-hub/domain/money.ts`'s minor-unit arithmetic). The FIRST break is recorded (`firstBreakRowNumber`); later, cascading discrepancies from that same break are not separately reported.
2. **Opening/closing rollforward**: `openingBalance = firstBalanceRow.balance - signedAmount(firstBalanceRow)`; `expectedClosing = opening + Σcredits - Σdebits`; `variance = expected - reported`.
3. **Never silently pass** (mirrors the DB's own `chk_fdh_recon_reconciled` constraint): `reconciled` is returned ONLY when a variance was computed and equals zero (tolerance is always `0` for R7 — exact-Decimal equality, spec §67).

## Status resolution

| Condition | `status` |
|---|---|
| Zero transactions, or none carry a balance | `not_available` |
| Balance present on SOME but not all rows | `pending` — genuinely can't be concluded either way (see migration-note below) |
| Full balance coverage, a continuity break found, OR variance ≠ 0 | `failed` |
| Full balance coverage, no break, variance = 0 | `reconciled` |

**Why `pending` and not a fabricated `partial`**: `fdh_reconciliation_results.status` (frozen FDH-1 migration 0048) has no `partial` member — its closed vocabulary is `not_available`/`pending`/`reconciled`/`failed`/`user_accepted_exception`. Partial balance COVERAGE genuinely cannot be concluded, which is exactly what `pending` means; it is never reported as `reconciled`. The document-level `certification_status` (a brand-new R7 column) is where "partial" as a first-class OUTCOME lives — see `R7_CANONICAL_TRANSACTION_CONTRACT.md` §4.

## Date-coverage reconciliation (spec §44)

`computeDateCoverage()` derives `earliestDate`/`latestDate` from the actual accepted transactions (never assumed from a filename or a declared period alone) and, when a declared statement period exists, flags `withinDeclaredPeriod = false` if any transaction falls outside it. `rangesOverlap()` (pure interval arithmetic) compares the new statement's date range against every prior statement's own range for the same account, loaded via `loadPriorStatementDateRanges()` (paginated).

## Certified scenarios (cases R7-TC096-R7-TC120)

Clean multi-row reconciliation · a genuine balance break (never silently passed) · no balance column at all (`not_available`, never fabricated) · partial balance coverage (`pending`) · exact-precision variance (A$0.01 detected, not rounded away) · a 50-row fully-consistent run · a break in the middle of a long run (caught at the exact row) · credits/debits interleaved correctly · date coverage inside/outside a declared period · overlap detection (adjacent-but-not-overlapping, fully-contained, identical single-day ranges).

## Negative controls (spec §70-71 — RED→GREEN)

- **NC2 (sign)**: inverting the recorded `credit_debit` for a known-correct statement (simulating an adapter with the debit/credit convention backwards) causes reconciliation to FAIL — RED — proving the sign convention is load-bearing for reconciliation, not decorative. The correct (non-inverted) statement reconciles cleanly — GREEN.
- **NC3 (date)**: interpreting a genuinely swappable date (`03/04/2026`) under `MM/DD/YYYY` instead of the adapter-proven `DD/MM/YYYY` silently produces a DIFFERENT calendar date (4 March instead of 3 April) — RED, demonstrating exactly the "ambiguous date silently guessed" failure mode spec §91 names as a critical-fail condition. The adapter-proven format parses correctly — GREEN. A genuinely impossible cross-format date (month 25) fails to parse under the wrong format at all, a second demonstration of the same load-bearing assumption.

Both are embedded in `tests/unit/r7Reconciliation.test.ts` (R7-TC116-120), same inline-reimplementation methodology as NC1/NC5 — see `R7_DEDUPLICATION_METHODOLOGY.md`'s closing note.

## Reconciliation persistence

One `fdh_reconciliation_results` row is written per processing attempt (via the service-role client — see `R7_SECURITY_VERIFICATION.md`), plus five `fdh_data_quality_results` rows per document (`transaction_count_valid`, `account_identified`, `balance_reconciled`, `statement_period_found`, `duplicate_file`) using the frozen FDH-1 `check_code` vocabulary — no widening needed (`R7_CANONICAL_TRANSACTION_CONTRACT.md` §2).
