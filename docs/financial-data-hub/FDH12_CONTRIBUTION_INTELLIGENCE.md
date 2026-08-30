# FDH-12 — Contribution Intelligence

Spec sections 21, 28-32, 114-118.

## Vocabulary

The complete spec-section-21 activity set (17 types), classified by an ORDERED
first-match-wins rule list with `unless` vetoes
(`retirement/activityClassification.ts`), the same shape FDH-9 certified.

Ordering is load-bearing. `SALARY_SACRIFICE` and `GOVERNMENT_CONTRIBUTION` are
matched BEFORE `PERSONAL_CONTRIBUTION` (both contain "contribution");
`INSURANCE_PREMIUM` and `TAX` before `FEE` (an insurance premium is not an
admin fee, and "contributions tax" is not a fee); `PENSION_PAYMENT` before
`WITHDRAWAL`.

An unmatched label becomes `UNKNOWN`, which has a **null** balance direction —
so an unclassified line makes a statement report VARIANCE or INSUFFICIENT_DATA
rather than a confidently wrong RECONCILED.

A directionless "Rollover" with no in/out word is `UNKNOWN` on purpose:
guessing the direction of a $100,000 movement is precisely what spec section 33
is about.

## Economic semantics

| Activity | Balance | Household cash | Notes |
| --- | --- | --- | --- |
| `EMPLOYER_CONTRIBUTION` | + | none | Spec 28-29: not a household expense, and not a second cash salary receipt. |
| `SALARY_SACRIFICE` | + | none | Spec 31: gross salary and tax are never re-derived from the statement. |
| `GOVERNMENT_CONTRIBUTION` | + | none | Spec 32: never classified as ordinary salary. |
| `PERSONAL_CONTRIBUTION` | + | **debit** | Spec 30: bank −$5,000 / super +$5,000 is a transfer. Ordinary consumption expense: $0. |
| `ROLLOVER_IN` / `ROLLOVER_OUT` | +/− | none | Spec 33-35. |
| `INVESTMENT_EARNINGS` / `INTEREST` / `DISTRIBUTION` | + | none | Spec 39-40: retained inside the fund. |
| `FEE` / `INSURANCE_PREMIUM` / `TAX` | − | none | Spec 41-45: internal deductions. |
| `WITHDRAWAL` / `PENSION_PAYMENT` | − | **credit** | Spec 36-38: matched, but NO tax treatment invented. |
| `ADJUSTMENT` / `OTHER` / `UNKNOWN` | — | — | No defined direction; excluded from the identity. |

"Household cash: none" is not enforced by a rule — FDH-12 has **no write path**
to income, expenses or `fdh_transactions` at all. Nothing could create one.

## YTD and subtotals — the no-double-count discipline

Two independent flags, both system-owned:

* **`is_year_to_date`** — FDH-9's certified discipline, same column name.
  Spec 115: current $1,000 + YTD $8,000 = current event **$1,000**, never
  $9,000. YTD figures live in their own `ytd_*` columns and are never added to
  the period ones.
* **`is_summary_total`** — spec 116-118. An annual statement printing
  "Total employer contributions 12,000" above twelve monthly lines of 1,000
  reconciles to **12,000**, never 24,000.

Both are excluded from activity-level reconciliation, from fingerprinting (a
subtotal has no economic identity) and from payslip matching. The negative
control in `tests/unit/fdh12FinancialIntegrity.test.ts` deliberately clears the
flag and shows the arithmetic then goes wrong — proving the exclusion is
load-bearing.

## Contribution totals reaching canonical Retirement

Canonical Retirement stores a contribution **rate**
(`employer_contribution` + `contribution_frequency`), not a history. FDH-12
therefore proposes those columns with `requires_confirmation = true` and
`isRecommended = false`: a statement's period total is only the user's ongoing
rate if the user says so. They are never ticked by default.
