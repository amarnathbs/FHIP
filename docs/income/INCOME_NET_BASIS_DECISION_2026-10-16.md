# Income net (take-home) basis - PO decision 16-10-2026

This decision deliberately REVERSES the certified GAP-09 rule ("a blank take-home is unknown and contributes nothing to net
income"). Where older documents (UPLOAD_FIELD_DISPOSITION_REGISTRY, DOWNSTREAM_DATA_CONSUMER_MATRIX, APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX,
FINAL_COMPLETION_REPORT) still say "null = unknown, never gross", this page supersedes them.

## The rule (one place: `lib/engines/incomeNetBasis.ts`)

Per income record, on the record's OWN pay period (gross, take-home and tax share the record's frequency):

| Order | Basis | Net used | Shown as |
|---|---|---|---|
| 1 | entered | `net_amount` as entered or imported | nothing to disclose |
| 2 | derived_from_tax | `amount - tax_amount` (tax per period, 0 <= tax <= amount) | nothing to disclose |
| 3 | assumed_gross | the GROSS (no tax deducted) | amber notice naming the source and how many sources |

A tax above the gross, or a negative tax, is ignored (the gross is assumed). Variable pay of an Applied payslip has no take-home
either, so its gross is assumed too and it is named "Variable pay (payslip)".

## One figure, read everywhere

`selectIncome().combined.netMonthly` -> `dashboardCanonicalAdapter` -> `DashboardSummary.netMonthlyIncome` -> Dashboard, Monthly
Report, scores, resilience, DNA, Twin, What-if, AI context, snapshots. `monthlyCashFlow.ts` (monthly history) uses the same
`planned.netMonthly`. The registers-only engine path uses the same `resolveNetBasis`.

## What changes when the assumption is used

Anything computed from net income: net monthly income, monthly surplus or deficit, savings rate, cash-flow ratio, operating cash
flow, disposable income, discretionary ratio, debt-service ratio, and therefore the Cash Flow Health, Savings Behaviour and Debt
Health pillars, the resilience income-stress inputs and the Financial DNA / Twin income metrics. Debt-to-income (DTI) is on GROSS
income and does not change. Net worth does not change.

## Where it is disclosed

- Dashboard: amber banner "Gross is being treated as take-home: no tax has been deducted." with the count and the source names
  (`DashboardDataStatusNotice`), and a note on the Monthly Income card.
- Income page: the same banner plus the household take-home total (`ImportedIncomeActuals`).
- Monthly Report: Executive Summary surplus or deficit sentence, Cash Flow section, Core figures and Score pillars
  (`netIncomeBasisNote` in `lib/engines/reportSections.ts`).

## Entering the real figure

Income form: **Net Amount (take-home pay)** or **Tax per period (if no net amount)**. Both are per the row's own frequency.
Migration `0281` adds `income_sources.tax_amount` with `CHECK (tax_amount IS NULL OR (tax_amount >= 0 AND tax_amount <= amount))`.
Apply 0281 BEFORE deploying the code that sends `tax_amount` from the Income grid; the read model retries without the column
if it is missing, so reads never break.

## Sibling guard: one pay period per row

A payslip is ONE pay. Proposing its amounts onto an existing row of a different frequency used to put a fortnightly net on an
annual gross (PO production: 3,975.43 beside 196,994.48 annually). `incomeAdapter.buildProposal` now converts the payslip amounts
to the row's frequency (x 26 for fortnightly to annually) and leaves the row's frequency alone; `incomePeriodBasisViolation`
refuses any selection that would mix bases (also pre-flighted in `applyIncomeProposalAtomic` for proposals generated earlier).
`lib/engines/incomePlausibility.ts` flags a wage whose take-home is under 30% of its gross (or above it) on the Dashboard and the
report.
