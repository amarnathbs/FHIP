# FDH-6 — Financial Integrity Certification

## Source amounts never modified

No FDH-6 code path writes `amount_original`, `credit_debit`, `transaction_date`, or `source_reference`. `applyTransferClassOnConfirm()` only ever writes `economic_transaction_type`/`category_id`/`subcategory_id` via the existing `correctTransaction()` field whitelist (`FDH_TRANSACTION_CORRECTION_FIELDS`) — the same closed vocabulary R7 already enforces; `amount_original`/`credit_debit` ARE technically in that whitelist (a user may correct a genuine data-entry error) but FDH-6's own code never supplies them as `field_name`. Grep-verified: `grep -n "field_name:" lib/financial-data-hub/services/classificationReviewService.ts` shows only `'economic_transaction_type'`, `'category_id'`, `'subcategory_id'`.

## Exact money (spec section 72)

- `transferMatching.ts` buckets candidates by `${amountOriginal.toFixed(4)}|${currencyOriginal}` — string-keyed exact match, never a floating-point tolerance comparison.
- `refundReversalMatching.ts` compares `candidate.amountOriginal < refund.amountOriginal` (magnitude check) and computes `amountDelta` for reporting only, never for a match/no-match decision beyond the strict `<` check.
- Split allocations (`fdh_transaction_allocations`, FDH-1) reconcile via `lib/financial-data-hub/domain/allocations.ts`'s `checkAllocationsReconcile()`, which converts to INTEGER minor-currency-units (`toMinorUnits()`) before summing — never JavaScript floating-point addition on decimal currency values. FDH-6 did not modify this file; it is exercised directly (not re-implemented) in the live-DEV split test.

## UNKNOWN survives safely (spec sections 19, 136)

Proven throughout the certification pack — a transaction that cannot be safely classified NEVER receives an invented economic type. The rule-conflict addition specifically strengthens this: a genuine same-priority disagreement between two active rules now produces `unknown`/`RULE_CONFLICT` rather than an arbitrary (and non-deterministic) pick.

## No income/expense double-counting (spec sections 22, 128, 136)

`applyTransferClassOnConfirm()` is the direct fix for this FAIL condition — see `FDH6_TRANSFER_INTELLIGENCE.md`. Before FDH-6, a confirmed transfer's two transaction rows could persist as two independent `unknown` rows forever; after FDH-6, both correctly carry `economic_transaction_type = 'transfer'`, which is neither `income` nor `expense`.

## Split integrity (spec sections 65-67)

`fdh_transaction_allocations` (FDH-1 schema) + `assertAllocationsReconcile()` (FDH-1 domain logic, unmodified) — sum of allocations must equal the parent transaction's amount to within one smallest-currency-unit, using integer minor-unit arithmetic throughout. FDH-6 did not need to build this; it already existed, fully wired (schema + domain validator + `transactionAllocationsRepository`), with only the end-user HTTP/UI surface deferred to FDH-7 per spec section 112's own explicit allowance ("implement only necessary data/domain capability now"). Exercised live in `FDH6_LIVE_DEV_CERTIFICATION.md`'s split test.

## Negative controls (spec sections 73-76, 119)

See `tests/unit/fdh6IndependentCertificationPack.test.ts` sections D-H — transfer, duplicate, recurring and refund negative controls, plus explicit weakened-implementation PROOFS (`[NC-Transfer]`, `[NC-Duplicate]`, `[NC-Recurring]`, `[NC-Classification]`, `[NC-Pagination]`) demonstrating the harness would catch a deliberately degraded implementation.
