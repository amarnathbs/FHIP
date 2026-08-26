# FDH-9 — India Payslip Certification

## Extraction (pre-existing, re-run clean this pass)

4 India fixtures (`IN-01`..`IN-04`, `tests/fixtures/fdh9/payslips.ts`), each
with an independently hand-computed oracle. Covers: Basic + HRA + Dearness
Allowance + Special Allowance + Conveyance/LTA lines, TDS (income tax
withheld), Professional Tax (kept structurally separate from TDS — a state
levy, not income tax), Employee PF + Employer PF, NPS (employee + employer),
and YTD gross/tax alongside current-period figures. Part of
`tests/unit/fdh9PayslipExtraction.test.ts`'s **278/278 PASS**, re-run fresh
in this pass.

## End-to-end journey (spec section 46)

Identical user journey to the AU case (`FDH9_AU_PAYSLIP_CERTIFICATION.md`),
country-detected from the document itself (PF/UAN/UAN/UAN-style signals,
Basic/HRA/DA vocabulary — `detectPayslipCountry()`, pre-existing, unchanged)
rather than solely from the user's declared country, with the declared
country used only as a fallback when the document is ambiguous.

**Required outcomes, verified:**

- **Canonical Income updated only after Apply** — identical mechanism to
  the AU case: `fdh9_apply_income_proposal()` is the only path, exercised
  live against Postgres in `fdh9_certification.mjs`.
- **Retirement balance not created** — `computeRecurringGross()` /
  `incomeAdapter.buildProposal()` never write to any retirement/PF/NPS table;
  `INCOME_APPLICABLE_FIELDS` (the adapter's hard allow-list, enforced both in
  application code and inside the RPC's own `v_allowed` array) contains no
  retirement-related column at all — there is structurally no way for an
  Income apply to touch a PF/NPS balance. See "Evidence integrity" in
  `FDH9_FINANCIAL_INTEGRITY_CERTIFICATION.md`.
- **Tax liability not calculated** — `tax_withheld` (TDS) is extracted and
  displayed on the review screen; nothing in FDH-9 computes an annual
  liability, a refund estimate, or a tax slab from it.

**Live-DEV status**: identical caveat to the AU case — not run against a
real Supabase project in this pass (`FDH9_LIVE_DEV_CERTIFICATION.md`).

## India-specific financial rules verified

- **Employee PF and Employer PF are both evidence, never income or a
  retirement-balance mutation** — `employeeRetirementContribution` /
  `employerRetirementContribution` map generically to the same fields the AU
  case uses for superannuation (spec section 39's rule applies identically
  to both jurisdictions); neither is ever added to `computeRecurringGross()`.
- **NPS contributions** (`employer_nps_contribution` /
  `employee_nps_contribution`) are extracted into their own dedicated
  columns, distinct from PF, so a payslip carrying both never has one
  overwrite or get summed into the other.
- **Professional Tax vs. TDS** are two separate columns
  (`professional_tax` / `tax_withheld`) — a payslip that discloses both
  never has one silently absorbed into the other's reconciliation role.
