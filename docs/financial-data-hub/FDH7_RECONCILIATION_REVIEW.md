# FDH-7 — Reconciliation Review

## Principle (spec 16-19)

FDH-7 never recomputes reconciliation. `GET /api/financial-data-hub/documents/{id}/review-summary` reads `fdh_reconciliation_results` (R7's certified engine) verbatim and republishes the exact stored fields: `opening_balance`, `extracted_credits`, `extracted_debits`, `expected_closing_balance`, `reported_closing_balance`, `variance`, `status`. No arithmetic on these values happens in the route — grep-verified (`review-summary/route.ts` contains no `+`/`-` over these fields).

## Honest "not available" (spec 19)

When no `fdh_reconciliation_results` row exists for a statement, the response is `{ status: 'not_available' }` — never presented as `'reconciled'`. This is a direct consequence of the table's own `chk_fdh_recon_reconciled` constraint (FDH-1, migration 0048), which structurally cannot record `'reconciled'` without a variance within tolerance.

## Approval blocking (spec 18, 54, negative control spec 127)

A statement whose reconciliation `status = 'failed'` cannot be approved — enforced by `fdh7_statement_has_blocking_issue()` (DB function) and re-checked by `approveStatement()` before any write. DB-tested with an exact $0.01 variance (`scripts/fdh7_certification.mjs` section 3): blocked while `status='failed'`, unblocked the instant `variance` is corrected to exactly `0` and `status` moves to `'reconciled'`. A `'user_accepted_exception'` status (explicit user override of a real variance, an R7 capability) is treated as acceptable — it is not `'failed'`, matching the existing R7 semantics unchanged.

## Not the frontend's job (spec 17)

No client-side reconciliation formula exists anywhere in the FDH-7 code added — the UI (out of scope for this backend-focused phase, per the existing design-system precedent) would consume `review-summary`'s response directly.
