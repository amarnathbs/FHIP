# FDH-9 — Financial Integrity Certification

The mandatory negative controls (spec sections 47-58), consolidated with
where each is proven.

## Gross-to-net reconciliation exactness

- Expected net = actual net -> `RECONCILED`.
- A **$0.01** discrepancy -> `VARIANCE`, never silently absorbed as
  "close enough". Proven in `reconciliation.ts`'s own design (zero-minor-unit
  tolerance, via `domain/money.ts`'s integer minor-unit arithmetic) and
  exercised by dedicated fixtures in `tests/fixtures/fdh9/payslips.ts` /
  `fdh9PayslipExtraction.test.ts` (part of the 278/278).
- Incomplete payslip (ambiguous or missing deduction evidence) ->
  `INSUFFICIENT_DATA`, a first-class correct outcome — never a fabricated
  deduction figure invented to force a reconciliation.

## Bank matching (MATCH_THRESHOLD = 0.65, unchanged this pass)

- **Exact match**: employer + amount + date proximity -> `matched`.
- **Wrong-employer, same-amount** (spec section 33's own named example): a
  same-day, same-amount credit from an unrelated payer does **not**
  auto-match — amount agreement alone is `AMOUNT_WEIGHT = 0.35`, below
  threshold; the fix that raised the threshold from an earlier `0.6` (which
  amount + date-proximity alone could clear) to `0.65` is documented in
  `bankMatch.ts`'s own header and re-verified unregressed by
  `fdh9_certification.mjs` (unchanged this pass) and
  `fdh9DoubleCountCertification.test.ts` (re-run clean this pass).
- **Ambiguous** (two plausible deposits): `multiple_candidates`, surfaced to
  the user as "We found more than one possible matching deposit. Please
  review." (`PayslipImportPanel.tsx`'s `bankMatchLabel`) — never an arbitrary
  first-match pick.
- **No bank evidence**: `not_attempted`/`no_match` -> "No matching bank
  evidence is currently available" — never presented as a parsing failure.

## Payslip + bank double-count (spec sections 35, 87 — the platform's two
non-negotiable financial controls)

A payslip's net pay and its matched bank deposit are **evidence for the
same event**, not two events. Mechanically enforced at three independent
layers, all unchanged and re-verified this pass:

1. **Database**: `uq_fdh_payroll_events_bank_match` — a unique partial index
   on `bank_match_transaction_id` — makes it structurally impossible for two
   payroll events to claim the same bank transaction as corroboration.
2. **Adapter**: `incomeAdapter.buildProposal()` never reads
   `bank_match_transaction_id`'s amount into any proposed field — the
   proposed `amount`/`net_amount` come from the payslip's own
   `gross_pay`/`net_pay` only.
3. **Certification oracle**: `fdh9_certification.mjs` §9f explicitly forces
   the naive sum ($4,250 + $4,250 = $8,500) and proves the harness rejects
   it — the correct, certified answer is ONE economic event of $4,250.

## YTD negative control

Current-period gross ($5,000) must never be contaminated by YTD gross
($40,000) to produce $45,000. `PayrollExtraction` holds `grossPay` and
`ytdGross` as structurally separate fields; nothing in the parser, the
reconciliation engine, or the income adapter ever sums them.
`fdh9_certification.mjs` §9g is the live oracle proving this distinction is
real, not merely typed.

## Evidence integrity (spec sections 53-58)

- **Retirement evidence never creates a balance**: `INCOME_APPLICABLE_FIELDS`
  (the adapter's hard allow-list, independently re-enforced inside the
  `fdh9_apply_income_proposal()` RPC's own `v_allowed` array) contains no
  super/PF/NPS/investment column — an Apply operation is structurally
  incapable of touching any such balance regardless of what a forged
  proposal might claim (the RPC's allow-list check runs before any dynamic
  SQL is built).
- **Reimbursement never becomes recurring salary**: `incomeAdapter.ts`'s
  `computeRecurringGross()` subtracts `reimbursementsTotal` from the
  recurring-gross proposal whenever `reimbursementsIncludedInGross` is true.
  This pass's `incomeProposalService.ts` sets that flag to `true` whenever a
  payslip discloses any reimbursement line at all (`FDH9_PAYROLL_
  ARCHITECTURE.md`'s "Reimbursement-in-gross modelling decision") — the
  conservative choice given the parser cannot know whether the payslip's own
  header gross already included it, made explicitly so a reimbursement can
  never inflate the proposed recurring income.
- **Bonus/overtime never silently becomes permanent recurring income**:
  `computeRecurringGross()` subtracts bonus/overtime/commission/arrears from
  the recurring-gross figure unconditionally; `hasVariablePay()` flags the
  period as containing variable pay, which the adapter surfaces as its own
  separate, clearly-labelled line ("Variable pay this period... Recorded as
  evidence — not added to your regular income") rather than folding it into
  the headline number.
- **Multiple employers remain separate**: `findDuplicateIncome()` matches on
  folded employer name (or, as a fallback, a `source_name` that contains the
  employer and is typed `salary`) — a payslip from Employer B never matches
  an existing Income row for Employer A merely because the amounts happen to
  coincide.
- **Duplicate payslip**: the unique `(user_id, payslip_fingerprint)` index
  is the backstop; `payslipProcessingService.ts` catches the resulting
  `23505` and returns the **existing** payroll event
  (`pipelineStatus: 'duplicate_payslip'`) rather than creating a second one
  — surfaced to the user as a truthful banner, not a processing error
  (`FDH9_INCOME_TAB_UX.md`'s `duplicate` phase).
- **Revised payslip**: `superseded_by_payroll_event_id` exists on
  `fdh_payroll_events` for this purpose (pre-existing schema, migration
  0091); this pass's processing service does not itself implement
  supersession detection (a revised payslip's different content produces a
  different fingerprint and is accepted as a new event rather than
  automatically linked) — recorded as a disclosed residual, not silently
  assumed solved, since the spec's own wording ("recognized... where
  existing logic supports it") anticipates this may not be complete.
