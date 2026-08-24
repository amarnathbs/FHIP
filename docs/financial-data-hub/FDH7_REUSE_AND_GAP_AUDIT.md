# FDH-7 — Reuse & Gap Audit

Real code/schema inspection performed before any FDH-7 code was written: migrations 0045-0075, `lib/financial-data-hub/**`, `app/api/financial-data-hub/**`. Confirms this project's own stated expectation (orchestration note 11) — FDH-7 is overwhelmingly a reuse phase.

## Classification key
- **REUSE AS-IS** — used unmodified.
- **EXTEND** — additive columns/functions layered on an existing table/module.
- **NEW FDH-7 WORKFLOW** — genuinely new capability, no prior equivalent existed.
- **OUT OF SCOPE** — deliberately not touched (belongs to another phase).

## Findings

| Requirement | Status | Evidence |
|---|---|---|
| Canonical transaction model | REUSE AS-IS | `fdh_transactions` (0047) |
| Split/allocation schema | REUSE AS-IS (schema); **NEW FDH-7 WORKFLOW** (write path) | `fdh_transaction_allocations` (0047) existed with RLS/indexes; `domain/allocations.ts#checkAllocationsReconcile/isValidAllocationDraft` existed and is exact-money-correct. **No code anywhere in the tree wrote to this table before FDH-7** — confirmed by grepping `app/api/financial-data-hub` and `lib/financial-data-hub/services` for `transaction_allocations` prior to this phase: zero API routes, zero service functions. `services/transactionSplitService.ts` is the first writer. |
| Transfer/refund/reversal/duplicate relationship model | REUSE AS-IS | `fdh_transaction_links` (0047), `fdh_duplicate_candidates` (0047) |
| Transfer confirm/reject | REUSE AS-IS | `classificationReviewService.ts#reviewTransactionLink` (R8) already implements confirm/reject with DB-trigger-enforced `pending -> confirmed/rejected`, including the transfer write-back fix from FDH-6 (`applyTransferClassOnConfirm`). |
| Duplicate confirm/keep-both | REUSE AS-IS | `bankTransactionActionsService.ts#resolveDuplicateCandidate` (R7) |
| Recurring confirm/pause/resume/end | REUSE AS-IS | `classificationReviewService.ts#reviewRecurringSeries` (R8) |
| Correction workflow + audit | REUSE AS-IS | `bankTransactionActionsService.ts#correctTransaction`, `fdh_transaction_corrections` (R7) |
| Review reason codes | REUSE AS-IS | `classification/reviewReasons.ts#deriveReviewReasons` (FDH-6) — 7 of spec section 22's codes already implemented. |
| Review priority ordering | **NEW FDH-7 WORKFLOW** | No prior centralised ordering existed. `domain/approvalPolicy.ts#FDH7_REVIEW_PRIORITY_ORDER`/`reviewPriorityRank`. |
| Reconciliation engine/result | REUSE AS-IS | `fdh_reconciliation_results` (0048), R7's `bank-csv/reconciliation.ts`. FDH-7 never recomputes; `review-summary` route reads the stored row verbatim. |
| Statement processing lifecycle | REUSE AS-IS (transitions unchanged) + **EXTEND** (DB-level guard added) | `documentLifecycle.ts#DOCUMENT_STATUS_TRANSITIONS` (FDH-3) unmodified. **Gap found and closed**: no DB trigger ever enforced this table, only application code — see "Critical Finding 2" below. |
| Genuine user approval (transaction/statement) | **NEW FDH-7 WORKFLOW** | No prior concept of a deliberate, blocking-gated approval action existed at all — see "Critical Finding 1". |
| Approved Financial Summary | **NEW FDH-7 WORKFLOW** | No table, no service, no oracle existed. `fdh_approved_financial_summaries` (0076), `domain/approvedSummary.ts`. |
| Bulk review/approval | **NEW FDH-7 WORKFLOW** | No bulk endpoint existed. `domain/approvalPolicy.ts#runBulkAction`, `bank-transactions/bulk-approve`. |
| Reopen workflow | **NEW FDH-7 WORKFLOW** | No reopen concept existed. `approvalService.ts#reopenStatement`. |
| Audit trail | REUSE AS-IS (mechanism) + **EXTEND** (5 new event types) | `fdh_document_audit_events` (FDH-3) + `recordDocumentAuditEvent()` reused verbatim; widened additively per the established R7/R8/FDH-5 precedent. |
| Purge lifecycle | REUSE AS-IS | `services/purge.ts`, `domain/documentLifecycle.ts#isPurgeEligible`. Not modified — see "Critical Finding 3" (disclosed, not silently patched). |
| Investment/Input Data boundaries | OUT OF SCOPE (respected) | No file under `lib/services/investment-intelligence/**` or the 7 `FHIP_PROTECTED_INPUT_TABLES` touched — grep-verified, zero matches. |

## Critical Finding 1 — "Approval is not import success" was genuinely violated pre-FDH-7

`bankCsvProcessingService.ts`/`bankPdfProcessingService.ts` already move `fdh_statement_uploads.processing_status` all the way to `'approved'` for any statement R7/FDH-5 certifies as fully clean and reconciled — **with no user action whatsoever**. `approved_at` (column present since migration 0046) had never actually been written by any code path before this phase (confirmed by exhaustive grep). This is exactly the anti-pattern spec sections 14/55/159 warn against.

**Resolution, not a rewrite**: FDH-7 does not touch R7/FDH-5's certified, live-tested auto-progression (out of narrow scope; would regress two already-certified phases). Instead, `approved_by` (new, additive column) becomes the **one and only** authoritative signal of genuine user approval — `processing_status = 'approved'` continues to mean "R7/FDH-5 certified this import as clean", a structurally distinct, weaker fact. The Approved Financial Summary, the approval API, and any future FDH-15 bridge key exclusively off `approved_by`/the existence of an `fdh_approved_financial_summaries` row.

## Critical Finding 2 — `processing_status` had no DB-level transition enforcement

`documentLifecycle.ts#DOCUMENT_STATUS_TRANSITIONS` governed every application code path since FDH-3, but no CHECK constraint or trigger ever enforced it in Postgres. A forged direct PostgREST request carrying the row owner's own valid JWT could set `processing_status` to any value from any state — including a straight jump to `'approved'`, which `isPurgeEligible()` treats as purge-eligible, meaning a raw document could become purge-eligible without ever having been processed.

**Closed, additively, in migration 0076**: `fdh7_guard_document_processing_status()` mirrors the exact, already-agreed TS transition table in SQL. It can only ever reject a transition the application layer would already have rejected — no legitimate write path changes behaviour (confirmed: `tsc --noEmit` clean, full Vitest suite green — see `FDH7_COMPLETION_REPORT.md` section 17). Live-DB-tested: `scripts/fdh7_certification.mjs` section 4, 4/4 PASS including spec 109's own two explicit examples (PURGED→APPROVED, REJECTED→APPROVED).

## Critical Finding 3 — purge eligibility is unaffected, and that gap is disclosed, not silently patched

Because Finding 1 is resolved via a *separate* signal (`approved_by`) rather than by changing `processing_status`'s meaning, `isPurgeEligible()` (keyed on `processing_status = 'approved'`) is **unchanged**. This means a "certified, clean" CSV/PDF import can still become purge-eligible via R7/FDH-5's existing auto-progression, before a human genuinely reviews it — a pre-existing FDH-3/R7/FDH-5 privacy-adjacent gap, not introduced or silently fixed by this phase. Disclosed in `FDH7_PRIVACY_AND_PURGE.md` and the completion report's Open Residuals, exactly as spec section 137 requires for anything touching production behaviour.

## Zero duplicate engines (spec section 10)

Duplicate reconciliation engines: **0**. Duplicate categorisation engines: **0**. Duplicate merchant engines: **0**. Duplicate transfer engines: **0**. Duplicate dedup engines: **0**. Duplicate recurring engines: **0**. FDH-7 consumes R7/R8/FDH-6's results via the existing repositories and read-only RPCs; it computes no classification, no matching, no reconciliation of its own — its only new computation is the Approved Financial Summary aggregation (`domain/approvedSummary.ts`), which is explicitly a REVIEW/APPROVAL-layer concern, not a competing intelligence engine.
