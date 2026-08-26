# FDH-9 — Income Tab UX

Written during the live-DEV-cert + Income-tab pass (2026-08-26). Documents
the actual implementation of the previously-undisclosed gap (spec sections
21-46): the entire user-facing journey did not exist before this pass — the
prior hardening pass's own honest correction in `FDH9_REUSE_AND_GAP_AUDIT.md`
already flagged this.

## Where it lives, and why (spec section 3)

FDH-9 is **not** a new top-level destination. `app/(app)/income/page.tsx`
gained one CTA ("Import from Payslip") above the existing, **completely
unmodified** manual Income grid (`components/grid/FinancialDataGrid` +
`incomeGridConfig`). The payslip journey itself is one component,
`components/income/PayslipImportPanel.tsx`, that expands inline below the CTA
— no separate route, no separate page, no modal-routing complexity.

`PayslipImportPanel.tsx` talks to the FDH-backed API surface purely over
`fetch()` — the same relationship any HTTP client has to a public API route,
not a module import of FDH's internals. See `tests/unit/
fdh1Isolation.test.ts`'s own comment on why this file (and `lib/import-bridge/
incomeProposalService.ts`) are named in that test's `FDH_APPROVED_CONSUMER_
FILES` allowlist, and `FDH9_SECURITY_CERTIFICATION.md` for the isolation
re-verification.

## The journey, state by state (spec sections 4, 28)

| Phase | What the user sees | Mutates Income? |
|---|---|---|
| `form` | Country selector (AU/India) + PDF file picker. Copy: "Upload a payslip and FHIP will extract your income details for you to review before updating your Income information." (spec section 24 — never "automatically updates") | No |
| `uploading` | "Uploading your payslip…" | No |
| `processing` | "Processing your payslip — extracting payroll information…" | No |
| `unable_to_read` | The specific truthful failure message (password/corrupt/scanned-OCR/unrecognised-layout — see `PAYSLIP_FAILURE_MESSAGES`), never a raw error code, never a fabricated $0 | No |
| `review` | Employer, pay period, gross/ordinary/overtime/bonus, tax withheld, employer retirement contribution (labelled "evidence only — not added to your income"), net pay, gross-to-net status, bank-match status. `[Review/Correct]` `[Approve]` | No |
| `duplicate` | Same review screen, plus a banner: "This payslip has already been uploaded. Showing the evidence already on file." No second event is created (see `FDH9_FINANCIAL_INTEGRITY_CERTIFICATION.md`) | No |
| `comparing` | CURRENT vs PROPOSED comparison table, one row per field, a per-field "apply this field" checkbox, and the four-way decision (Add New / Update Existing / Apply Selected Fields / Keep Existing) | No |
| `stale` | "Your Income information has changed since this proposal was created. Review the latest values before applying." + a "Refresh comparison" action that regenerates the proposal against current data | No |
| `applied` | Confirmation. **This is the only phase in which Income has changed**, and only after the user's own Apply click | **Yes — exactly here** |
| `kept_existing` | "Your existing income was kept unchanged." | No |
| `error` | Generic, non-technical failure message + retry | No |

## "Review/Correct" — a deliberate, disclosed scope limit

The button exists (spec section 32's mock names it), but it opens the
**same read-only review screen**, not a field-editing form. `fdh_payroll_
events` has no authenticated-role UPDATE path for any system-derived field
(`FDH9_AUTHORITY_AND_MUTATION_MODEL.md` §1) by design — widening that trigger
to support inline correction would be a security-architecture change made
without the kind of cause spec section 7 requires, for a UI affordance the
spec's own journey (section 4) does not actually depend on: a user who
disagrees with the extraction can decline to Approve, delete the document
(existing FDH-3 lifecycle), and either re-upload a clearer payslip or use the
always-available manual Income entry instead. Recorded here as an explicit
residual, not silently narrowed.

## Accessibility (spec section 59)

- The panel is `role="region"` with an accessible label, and
  `aria-live="polite"` so phase transitions ("Processing…" -> "Ready to
  review") are announced.
- Every status line (`role="status"`) carries text, not colour alone
  (reconciliation/bank-match state, upload/processing state).
- The comparison table has a `<caption>` (visually hidden, screen-reader
  only), proper `<th scope="col">`/`<th scope="row">`, and each per-field
  checkbox has an explicit `aria-label` ("Apply Gross amount") rather than
  relying on visual proximity alone.
- The decision control is a native `<fieldset>`/`<legend>`/radio group, so
  keyboard operation and screen-reader grouping both work without any custom
  ARIA.
- Every action is a labelled `<button>` with visible text — no icon-only
  controls.

## Responsive behaviour (spec section 59)

The comparison table sits inside `overflow-x-auto` rather than forcing a
fixed desktop-only layout — on a narrow viewport it scrolls horizontally
within its own container instead of one column becoming unreadable or the
page itself gaining horizontal scroll. No table cell truncates a money value.

## Loading vs. zero (spec section 59, 63)

Every extracted money value renders through a single `money()` helper that
distinguishes `undefined` ("not shown on payslip") from `0` ("the payslip
says zero") — the same discipline `PayrollExtraction`'s own type definitions
already establish (`types.ts`'s header comment: "`undefined` is a materially
different fact from `0`, and nothing in FDH-9 coerces one into the other").
The `processing`/`uploading` phases render a text status line, never a
zeroed-out review screen.

## Privacy (spec section 62)

The review screen renders only the fields `getPayrollEventForReview()`
selects (`*` from `fdh_payroll_events`, which — per the parser's own privacy
module, `privacy.ts` — never contains a TFN, PAN, full bank account number,
full address, or employee ID in the first place; nothing is extracted into
any FDH-9 column that isn't already privacy-scrubbed at the parser layer).
No raw payslip text ever reaches the client.

## No raw payslip logging (spec section 63)

Grepped by hand across every file this pass added:
`payslipProcessingService.ts`, `incomeProposalService.ts`, all 6 new routes,
`PayslipImportPanel.tsx`. Zero occurrences of `console.log`, `console.info`,
`console.error`, or `JSON.stringify` applied to extracted text, the raw PDF
buffer, or a full payroll-event object. The one audit-event metadata payload
each route writes (`recordDocumentAuditEvent(..., metadata: {...})`) carries
only ids, statuses, and field-name lists — never a money value taken directly
from the payslip and never the payslip text itself.
