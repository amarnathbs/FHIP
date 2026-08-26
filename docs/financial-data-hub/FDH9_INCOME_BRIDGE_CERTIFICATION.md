# FDH-9 — Income Bridge Certification

Consolidates the generic import-bridge guard logic's own certification
(`tests/unit/fdh9IncomeBridge.test.ts`, pre-existing, unchanged and re-run
clean by this pass) with the new route-level wiring this pass added.

## The minimum test list (spec section 66), and where each lives

| Scenario | Proven by |
|---|---|
| No existing Income -> Add New | `fdh9IncomeBridge.test.ts` (`incomeAdapter.buildProposal` with empty `existing`) + `fdh9_certification.mjs` §3 (`add_new` happy path, live against Postgres) |
| Same employer -> Update Existing | `fdh9IncomeBridge.test.ts` (`findDuplicateIncome` employer-fold matching) + `fdh9_certification.mjs` §3 (`update_existing`) |
| Different employer -> Add New | `fdh9IncomeBridge.test.ts`'s "add new" block proves the `add_new` apply path end-to-end (no existing match, creates exactly one row, repeat-apply does not duplicate). `findDuplicateIncome`'s fold-matching is proven positively (same employer matches, above) — the negative case (a genuinely different employer name folds to a different string and therefore does not match) follows from the same string-comparison logic and is not separately named as its own test; recorded here rather than silently assumed. |
| Keep Existing | `fdh9_certification.mjs` §3 — Income unchanged, proposal dismissed, no application row |
| Apply selected fields | `fdh9_certification.mjs` §3 — amount changes, frequency (not selected) does not |
| No Apply | `fdh9_certification.mjs` §5 (stale) + the UI's own `comparing` phase never calling the apply route until the user clicks Apply (`PayslipImportPanel.tsx` — `handleApply` is wired only to the "Apply" button's `onClick`) |
| Stale proposal | `fdh9_certification.mjs` §5, live against Postgres; the UI's `stale` phase (`FDH9_INCOME_TAB_UX.md`) |
| Duplicate Apply | `fdh9_certification.mjs` §6 — second call against an already-applied proposal returns `ALREADY_APPLIED`, not a second mutation |
| Concurrent Apply | `fdh9_certification.mjs` §6 — two genuinely concurrent calls against the same proposal, exactly one succeeds |
| Forged target Income | `fdh9_certification.mjs` §8/§9e — a foreign Income id as `target_entity_id` is rejected |
| Cross-tenant proposal | `fdh9_certification.mjs` §8 — Tenant B applying Tenant A's proposal is `PROPOSAL_NOT_FOUND`, no tenant leak |

## What this pass added on top: the HTTP route itself

Everything above certifies the **service functions**
(`applyIncomeProposalAtomic`, `incomeAdapter`, `proposalEngine`) directly.
This pass's new `POST /api/financial-data-hub/income-proposals/{id}/apply`
route is a thin, faithful wrapper around exactly those functions — verified
by hand (the route contains no mutation logic of its own; see
`FDH9_SECURITY_CERTIFICATION.md`) and covered by
`tests/unit/fdh9IncomeTabUx.test.ts` for the two properties a wrapper can
uniquely get wrong that the underlying function tests cannot see:

1. **Auth is checked before the decision is even parsed** — an
   unauthenticated request to the apply route returns 401 regardless of what
   `decision` value it carries.
2. **Request validation degrades safely** — an unrecognised `decision` value,
   or a request body missing `decision` entirely, returns 422 (a controlled
   client error), never a raw 500 or a silently-accepted no-op.

## Income Bridge -> Income tab wiring correctness

`incomeProposalService.ts`'s `generateIncomeProposal()` is gated on
`approval_status = 'approved'` (spec section 4's ordering: Approve then
Generate) — verified by reading the function directly:
`throw new IncomeProposalError('not_approved', ...)` when the payroll event
is not yet approved, and the `POST /payslip/{id}/proposal` route surfaces
that as a 409, which the UI never reaches in practice because it only offers
"Continue to income comparison" once `event.approval_status === 'approved'`
(`PayslipImportPanel.tsx`).
