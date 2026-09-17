# AIE-1 Closure — Document Class Register (mission section 10.4)

Verbatim source: `docs/aie-programme/AIE_1_4_IMPLEMENTATION.md` section 4's
eligibility table (the authoritative, literal source — the consolidated
report's own phrasing is a paraphrase, not a second source). This mission
did not implement any of the eight deferred classes, did not implement the
prohibited class, and did not expand AIE-1.4's own certified scope beyond
what is documented below.

| # | Class (verbatim) | Status | Reason (repo-grounded) | User-facing behaviour | Owner | Conditions for future work |
|---|---|---|---|---|---|---|
| 1 | Insurance | **IMPLEMENTED** (AIE-1.4) | Real mature RLS-protected `insurance_policies` table + live write service, reached previously only by manual entry, no PDF path — the gap AIE-1.4 existed to fill. | Real upload → extraction → review → correction → acceptance → canonical write, re-verified live-DEV by this closure mission (`AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md`). | AIE-1 programme | N/A — closed. |
| 2 | Payslip/income | DEFERRED | A mature, separate FDH payslip pipeline already exists (`lib/financial-data-hub/payslip/**`); wrapping it behind AIE properly is its own multi-session effort, not a quick multi-class touch. | Payslip upload continues through FDH's own existing, unrelated route — completely unaffected by AIE. | FDH / a future AIE phase | A dedicated AIE adapter phase, following the exact "wrap, don't rebuild" discipline AIE-1.2/1.3 already used for II/FDH-bank. |
| 3 | Loans/liabilities | DEFERRED | Same reasoning as payslip/income — `lib/financial-data-hub/liability/adapters/**` already exists as its own mature pipeline. | Unaffected — existing FDH liability route continues to serve this class. | FDH / a future AIE phase | Same as above. |
| 4 | Retirement/SMSF | DEFERRED | Same reasoning — `lib/financial-data-hub/retirement/**` already exists as its own mature pipeline (and FDH-12's own 179-section closure work covers this domain separately). | Unaffected. | FDH-12 / a future AIE phase | Same as above; should coordinate with FDH-12's own DEV-only status rather than duplicate it. |
| 5 | Asset/property/valuation | DEFERRED | Named, repo-grounded reason in AIE-1.4's own scorecard (no dedicated PDF ingestion path exists for this class at all yet, so there is no existing pipeline to wrap — a from-scratch build, out of AIE-1's "wrap what exists" mandate). | Unaffected — no PDF ingestion path exists for this class in or out of AIE. | A future, dedicated phase | Requires first building the underlying deterministic extraction/parser layer this class currently lacks entirely — not an AIE-scoped task by itself. |
| 6 | Goals | DEFERRED | Same reasoning as assets/valuation — goals have no document-based ingestion concept in this product at all (goals are user-entered, not document-derived). | Unaffected. | Product decision, not an engineering gap | Only relevant if a future product decision introduces document-derived goal data — not currently planned anywhere in this repo. |
| 7 | Bills/expenses/FDH linkage | DEFERRED | Named, repo-grounded reason in AIE-1.4's own scorecard — bills/expenses ingestion is tangled with FDH's transaction-classification pipeline in ways AIE-1.4's own discovery found required deeper, separate design work. | Unaffected — existing bills/expenses flows continue unchanged. | FDH / a future AIE phase | A dedicated design pass on how AIE's document-provenance model composes with FDH's existing transaction-classification linkage, before any adapter work starts. |
| 8 | Tax-supporting evidence | DEFERRED | Named, repo-grounded reason — no existing canonical "tax evidence" storage/table this class would write to (unlike insurance's `insurance_policies`), so there is no "wrap the existing write service" target yet. | Unaffected. | A future, dedicated phase | Requires the canonical tax-evidence data model to exist first — a product/schema decision, not an AIE-scoped task by itself. |
| 9 | Cross-border/jurisdiction documents | N/A (not an independent class) | AIE-1.4's own scope decision: satisfied via Insurance's existing country/currency gate (`countryCode`/`currencyCode` fields already flow through the Insurance adapter's schema) — no separate class needed. | Already covered by Insurance's existing AU/India currency support. | AIE-1 programme | N/A — resolved by design, not deferred. |
| 10 | Identity/medical/legal/sensitive | **PROHIBITED** | Explicitly prohibited by the AIE-1.4 spec itself — not a scope gap, a binding non-negotiable exclusion. | No AIE ingestion path exists, or will exist under this mission's authority, for this class. | N/A — out of AIE's mandate entirely | None — this is not "future work," it is excluded by design. Any future change would require an explicit, separate Product Owner authorisation overriding AIE-1.4's own binding prohibition, which this mission does not have and did not seek. |

## This closure mission's own scope against this register

Mission section 10.4 asked for two things beyond the register itself:

1. **"Inventory all eight deferred/prohibited classes using their actual
   names from the repository."** Done above — verbatim from
   `AIE_1_4_IMPLEMENTATION.md`.
2. **"Broader corpus expansion within currently supported classes is
   required where evidence is insufficient."** The only currently
   *supported* class is Insurance. This mission's own
   `AIE_1_CLOSURE_INSURANCE_REGRESSION_REPORT.md` re-ran the real
   end-to-end journey (upload → extract → review/correct → accept →
   canonical write → same-key replay) against the existing generic
   Label:Value fixture — the same synthetic fixture family AIE-1.4 always
   used (`documentCatalogue.ts`'s own disclosed header: "no real insurer's
   exact layout was sourced for this pass"). **No real insurer's exact PDF
   layout was sourced or tested by this closure mission either** — this
   remains the single most material open item for Insurance's own corpus
   coverage, carried forward unchanged from AIE-1.4's original disclosure,
   not newly discovered or newly closed by this mission.

Do not read this register, or any other document in this closure mission,
as claiming the original AIE-1.4 scope (all nine candidate classes) is
complete. One of nine is implemented; eight are deferred for named,
repo-grounded reasons; one is prohibited by design.
