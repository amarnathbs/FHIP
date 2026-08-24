# FDH-7 — Duplicate Review

R7 owns duplicate detection end to end; FDH-7 owns nothing new here.

## Actions (spec 38-40), all pre-existing

`POST /api/financial-data-hub/bank-transactions/{transactionId}/duplicate-resolution` (R7) with `{ duplicate_candidate_id, resolution: 'kept_both' | ... }`:
- **CONFIRM DUPLICATE**: candidate -> `confirmed_duplicate`; both transactions' `dedup_status` -> `user_confirmed_duplicate`. No physical delete happens (spec 39) — provenance is preserved, only the duplicate side's financial value is excluded from the Approved Financial Summary (see `FDH7_APPROVED_FINANCIAL_SUMMARY.md`).
- **KEEP BOTH**: candidate -> `not_duplicate`; both transactions' `dedup_status` -> `user_confirmed_distinct`. The unique-pair constraint (`uq_fdh_dupe_pair`, FDH-1) means the same pair can never re-surface as a fresh pending candidate (spec 40).
- **REVIEW LATER**: simply not acting — the candidate stays `pending`, and `fdh7_transaction_has_blocking_issue()` correctly keeps such a transaction blocked from approval until resolved.

## Summary exclusion (spec 59, 116-117)

`domain/approvedSummary.ts` excludes any transaction whose `dedup_status IN ('duplicate_confirmed', 'user_confirmed_duplicate')` from every total (counted once, not twice) while still counting it in `duplicate_excluded_count` — the row itself is never deleted. Legitimate `user_confirmed_distinct` repeats (KEEP BOTH) both count normally. Both behaviours have dedicated negative-control tests in `tests/unit/fdh7ApprovedSummaryOracle.test.ts`.
