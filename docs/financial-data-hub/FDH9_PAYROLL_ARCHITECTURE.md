# FDH-9 — Payroll Architecture

Written during the live-DEV-cert + Income-tab pass (2026-08-26), covering the
processing pipeline actually implemented: `lib/financial-data-hub/services/
payslipProcessingService.ts`.

## Pipeline shape

```
uploaded payslip (fdh_statement_uploads, document_type='payslip')
  -> download bytes (FDH-3 storage.ts, unchanged)
  -> extractPdfPages()            [FDH-5, reused unchanged]
  -> parsePayslipText()           [FDH-9 parser, pre-existing, unchanged]
  -> reconcileGrossToNet()        [FDH-9 reconciliation, pre-existing]
  -> matchSalaryDeposit()         [FDH-9 bankMatch, pre-existing, threshold 0.65]
  -> INSERT fdh_payroll_events + fdh_payroll_components   [NEW this pass]
  -> document processing_status -> 'extracted'
```

This is the direct payslip analogue of `bankPdfProcessingService.ts` (FDH-5):
same idempotency shape, same document-lifecycle discipline, same
download-once/extract/persist/transition structure. Nothing about the parser,
reconciliation, or bank-matching logic was changed by this pass — see
`FDH9_REUSE_AND_GAP_AUDIT.md` and the security-hardening docs for that
pre-existing, already-certified work. What this pass added is the
orchestration that actually calls them from an HTTP request and persists the
result.

## Idempotency and duplicate handling

- **Retry-safe**: a document stuck at `processing_status = 'failed'` is
  cleaned up (`cleanupPriorAttempt` deletes any partial `fdh_payroll_events`
  row for that document) and re-queued before the next attempt — identical
  discipline to the bank-CSV/bank-PDF services.
- **Already-processed**: if a payroll event already exists for the document
  and the document sits at `extracted`/`review_required`/`ready_for_approval`/
  `approved`, the service returns the existing event rather than reprocessing
  (`pipelineStatus: 'idempotent_existing'`).
- **Duplicate payslip** (spec section 57): the unique `(user_id,
  payslip_fingerprint)` index on `fdh_payroll_events` is the real backstop.
  A Postgres `23505` on that constraint is caught and turned into a
  `pipelineStatus: 'duplicate_payslip'` response carrying the **existing**
  payroll event's id — never a processing failure, never a second event.

## The one deliberate deviation from the FDH-5 pattern, and why

`bankPdfProcessingService.ts` calls `assertDocumentTransition('processing',
'queued')` on a password-required/invalid outcome to allow a retry. That
target is **not actually in** `DOCUMENT_STATUS_TRANSITIONS.processing`
(`../domain/documentLifecycle.ts` only allows `extracted`, `review_required`,
`failed`, `rejected` from `processing`) — a real, pre-existing defect in
already-shipped FDH-5 code, found while building this pipeline and left
unfixed as **out of FDH-9's scope** (spec section 2: "do not rebuild... unless
a genuine defect is discovered" — this is a FDH-5 defect, not an FDH-9 one).
`payslipProcessingService.ts` instead moves a password outcome to the
already-legal `processing -> failed` edge; its own re-entry check already
treats `failed` as retry-eligible, so `failed -> queued -> processing`
legitimately completes the retry without touching the broken edge at all.

## Bank-match candidate loading

`loadBankCandidates()` queries `fdh_transactions` for the user's own credit
transactions within a ±7-day window of the payslip's payment date (a read,
via the ordinary RLS-scoped client — no elevated privilege, no bank parsing:
spec section 20's "no bank parsing happens here"). `matchSalaryDeposit()`
(pre-existing, unchanged) does all of the actual scoring, including the
MATCH_THRESHOLD = 0.65 same-amount-plus-corroboration requirement.

## Reimbursement-in-gross modelling decision

`fdh_payroll_events.gross_pay` comes from the payslip's own **header** total
line, not a component sum — the parser cannot know whether that header figure
already includes a reimbursement line the payslip separately itemises. Given
that ambiguity, `lib/import-bridge/incomeProposalService.ts`'s
`toIncomeEvidence()` conservatively sets `reimbursementsIncludedInGross: true`
whenever `reimbursements_total > 0`, so a reimbursement is **always**
subtracted out of the proposed recurring gross rather than risking silently
inflating income (spec section 38). See
`FDH9_FINANCIAL_INTEGRITY_CERTIFICATION.md` §Reimbursement for the negative
control this decision is checked against.

## Tables touched (all pre-existing, from migration 0091 — no schema change this pass)

`fdh_statement_uploads` (existing FDH-3 lifecycle columns, via the
service-role client, identical carve-out to `bankPdfProcessingService.ts`),
`fdh_payroll_events`, `fdh_payroll_components` (both via the ordinary
RLS-scoped client — see `FDH9_AUTHORITY_AND_MUTATION_MODEL.md` §1-2 for why
that is the correct, deliberate choice), `fdh_transactions` (read-only).
