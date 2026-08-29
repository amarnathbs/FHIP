# FDH-10 — Expense Tracker Integration

## Zero changes required to FDH-8

`lib/financial-data-hub/analytics/financialActivityAnalytics.ts` — FDH-8's own aggregation engine — needs **no code change** for FDH-10. It already:

- sums `economic_transaction_type = 'expense'` rows and allocations into expense totals (`computeApprovedFinancialSummary`, FDH-7's oracle, reused unmodified);
- treats `'transfer'`-typed rows as excluded from both income and expense;
- reads `fdh_transaction_allocations` in preference to a parent row's own type when allocations exist.

This is exactly the behaviour FDH-10's economic classification produces: a card purchase written as `economic_transaction_type='expense'` is counted; a card-payment transaction classified `'transfer'` (whether by the existing bank-import classifier or by a future FDH-10 matching service) is excluded; a loan payment split via allocations into `debt_principal`/`debt_interest`/`fee` is counted correctly per-allocation (principal excluded, interest+fee counted) with **no code change to the aggregation layer at all**.

## Provenance preference (spec section 47)

When both a bank statement and a card statement exist for the same repayment, the card statement's economic detail (the underlying purchases) is preferred for spending detail, while the bank statement's transaction remains the settlement record the card statement's PAYMENT activity links to (`fdh_liability_statement_activities.linked_transaction_id`) — provenance from both sources is preserved, not overwritten.

## Bank-only vs card-only evidence (spec sections 48-49)

- **Bank statement only** (no card statement imported): FDH classification continues exactly as before FDH-10 existed — no card-specific categories are fabricated. `bank_match_status = 'not_attempted'`/`'bank_evidence_not_available'` on any FDH-10 evidence path always distinguishes "we have not looked" / "no bank evidence exists" from an actual parsing failure.
- **Card statement only**: card spending still produces expense evidence and updates the Liability; missing bank evidence is recorded as `bank_evidence_not_available`, never surfaced as an error.

## FDH-8 regression proof

`tests/unit/fdh8*.test.ts` (the full pre-existing FDH-8 suite) was re-run unchanged as part of the full-repository regression pass — see `FDH10_COMPLETION_REPORT.md`'s regression section for the exact pass count. FDH-10 introduces no FDH-8 file changes at all, so this is a genuine "unaffected by construction" result, not merely an assertion.

## Residual

No FDH-10 code path in this pass actually WRITES a card-statement-derived `fdh_transactions` row yet (the classification/planning logic in `creditCardEconomics.ts` is complete and certified; the persistence step that turns a `PlannedLedgerWrite` into a real row was not built this pass — see the completion report).
