# FDH-12 — Payslip Reconciliation

Spec sections 22-27, 64-67, 120. **The highest-risk control in the module.**

```
  Payslip employer super            $1,000
  Fund statement employer contrib.  $1,000
  ------------------------------------------
  CORRECT canonical contribution    $1,000
  FORBIDDEN                         $2,000
```

## Why $2,000 is unreachable — three independent layers

1. **Neither source posts to canonical.** FDH-9 holds employer super in
   `fdh_payroll_events.employer_retirement_contribution` and writes it nowhere
   (its apply RPC's allow-list is eight columns, none of them retirement).
   FDH-12 holds it as a statement activity and writes it nowhere either.
   Two evidence stores, zero postings — nothing to add up.
2. **The canonical contribution is a single proposed field.** An assignment,
   not an accumulation. No arithmetic exists that could produce $2,000. The
   RPC builds `col = value`, never `col = col + value` — asserted by test.
3. **One payslip evidences at most one fund contribution.** Migration 0112's
   `uq_fdh_retirement_activities_payroll_event` is a real unique index, proven
   live in PGlite.

This module's job is therefore not to prevent the double count — that is
structural — but to RECOGNISE the two records as one event so the UI can say
"Matched payslip: Yes" and show one financial event (spec 148).

## The match key (spec 24, 26)

`(employer, amount, date-within-window)` — never amount alone.

**Employer is a REQUIRED component**, not a tie-break. A pair where either side
has no comparable employer is not a candidate at all. That is what makes spec
section 26's control hold: Employer A $1,000 and Employer B $1,000 do not
match, and when both are present the RIGHT one is chosen. Employer names are
folded through FDH-9's own certified `normaliseEmployerName`, so
"ACME PTY LTD" matches "Acme".

Personal contributions are exempt from the employer requirement (they are made
by the member, not an employer); their key remains amount + date.

## The timing window (spec 25, 67)

**Forward 120 days, backward 7 days — deliberately asymmetric.**

Australian superannuation guarantee contributions are payable QUARTERLY: a July
period's super may lawfully be remitted as late as 28 October. Requiring
same-day equality would produce a false no-match on most real statements. 120
days covers the statutory quarterly cycle plus its 28-day deadline plus
clearing-house transit. Super arrives AFTER payroll, so a symmetric window
would admit implausible backward matches for no benefit.

When the statement states the pay period it relates to, that is used in
preference to a credit date (±31 days).

## Amount tolerance: ZERO (spec 66)

Payslip $1,000 vs fund $950 is **`variance_review_required`**, never a silent
choice of one. The exact variance (−$50.00) is reported so the user can see the
gap. A near miss (within 20%) becomes a visible candidate; an unrelated amount
is not a candidate at all.

`reconciledContributionMinorUnits()` returns `null` on disagreement — it has no
"pick a side" branch.

## Outcomes

| Status | Meaning |
| --- | --- |
| `matched` | One payslip, exact amount, employer agrees, within window. |
| `variance_review_required` | Same contribution, different amount. Spec 66. |
| `multiple_candidates` | Spec 27 — REVIEW, never the first, never the closest. |
| `no_match` | Payslips exist; none matches. |
| `payslip_evidence_not_available` | Spec 65 — **not a failure.** A fund contribution without a payslip is valid evidence and stands on its own. |

`no_match` and `payslip_evidence_not_available` are deliberately distinct so the
UI can say "no matching payslip" rather than "no payslips".

## What this module never does

Never writes back to FDH-9's tables. Never reads `gross_pay`, `tax_withheld` or
`net_pay` (spec 31 — gross and tax are never re-derived from a super
statement). Both asserted mechanically over the real source.
