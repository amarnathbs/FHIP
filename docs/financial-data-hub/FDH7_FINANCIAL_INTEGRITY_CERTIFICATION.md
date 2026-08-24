# FDH-7 — Financial Integrity Certification

## Independent oracle (spec 84-90, `tests/unit/fdh7ApprovedSummaryOracle.test.ts`, 16/16 PASS)

Every expected value hand-computed from the spec before running the function once — see the test file's own header. Covers: mixed-bucket summation, unknown visibility, cash-withdrawal isolation.

## Mandatory negative controls (spec 85-88, 127) — all present, all PASS

| Control | Fixture | Broken-implementation proof included |
|---|---|---|
| **Transfer double-count** (85) | Account A -1000 transfer + Account B +1000 transfer -> `income_total=0, expense_total=0, transfer_total=2000` | Yes — the SAME amounts mis-typed as expense/income produce the false 1000/1000 result, proving the correct case isn't accidentally passing |
| **Duplicate double-count** (86) | Same $89.95 transaction via CSV+PDF, one marked `user_confirmed_duplicate` -> counted once (`expense_total=89.95`) | Yes — without the exclusion, the identical fixture produces `179.90` |
| **Split 0.01** (87) | $300 parent, allocations $220.00+$79.99 | `FdhApprovedSummaryError` thrown; $220.00+$80.00 passes, produces exactly $300 |
| **Refund** (88) | $100 expense + $20 confirmed-linked refund -> `expense_total=80, refund_total=20` | Yes — the identical fixture with NO link produces `expense_total=100` (netting is not accidental/always-on) |

## DB-level negative controls (spec 127, `scripts/fdh7_certification.mjs`, 35/35 PASS — see `FDH7_LIVE_DEV_CERTIFICATION.md` for the honest "why PGlite, not live DEV" disclosure)

| Control | Result |
|---|---|
| Reconciliation altered by exactly $0.01 (`status='failed'`) | Statement approval blocked; fixed to exact 0 -> unblocked |
| Split allocation off by exactly $0.01 | Transaction approval blocked; fixed to exact sum -> unblocked |
| Tenant isolation disabled (`alter table ... disable row level security`) | Leak appears (proves the earlier PASS wasn't vacuous); re-enabling restores isolation |
| Approval-guard trigger dropped | The SAME forged approval that was blocked now succeeds; recreating the trigger blocks it again |
| State-machine bypass (PURGED->APPROVED, REJECTED->APPROVED) | Both explicitly rejected by the new `fdh7_guard_document_processing_status()` trigger |

## Exact money, no floating point (spec 83)

`domain/approvedSummary.ts` and `domain/allocations.ts` (reused, FDH-1) do every accumulation in integer minor units (`toMinorUnits`/`fromMinorUnits`, `domain/money.ts`). Dedicated regression: summing 1,000 × $0.10 lands on exactly $100.00 — the canonical case where naive JS float summation drifts.

## Unknown never disappears (spec 89)

`unknown_total` is a first-class bucket; a transaction with `economic_transaction_type = 'unknown'` is BLOCKED from approval in the first place (`fdh7_transaction_has_blocking_issue`) — it cannot enter an Approved Financial Summary silently, and if it somehow did (a future policy change), the summary would still show it, never drop it.

## Financial discrepancies found during this certification: **0**.
