# FDH-10 — Liabilities-Tab UX (FDH10-K)

## Status: NOT IMPLEMENTED this pass — honestly disclosed

Unlike FDH-9 (which shipped `app/(app)/income/page.tsx` + `PayslipImportPanel.tsx` + a full API route surface), FDH-10's UI/API layer was **not built** in this pass. This document records the intended design (so a follow-up pass has a concrete target) and the reasoning for the scope cut.

## Intended design (per spec sections 61-68, following the Income-tab precedent exactly)

```tsx
// app/(app)/liabilities/page.tsx (existing manual grid, unchanged)
<h1>Liabilities</h1>
<button>Import Credit Card Statement</button>
<button>Import Loan Statement</button>
// or a single "Import Statement" -> type-selection, whichever fits the design system
<LiabilityStatementImportPanel .../>  // new, mirrors PayslipImportPanel.tsx
<hr />
<FinancialDataGrid config={liabilitiesGridConfig} />  // existing, fully unaffected
```

- **Credit-card statement review**: opening/purchases/interest/fees/refunds/payments/closing balance, reconciliation status, transactions-requiring-review count.
- **Loan statement review**: opening/principal-repaid/interest/fees/closing balance, matched bank repayment.
- **Liability proposal compare**: current-vs-statement values, Keep Existing / Apply Selected Fields / Update Liability — nothing changes until Apply, exactly matching the Income-tab proposal compare UX already shipped.
- Card transaction review reuses the existing financial-activity/review infrastructure (FDH-8's Transaction Explorer / review queue) — no separate card categorisation screen.

## Why this was not built this pass

Per this dispatch's own stated priority order (hard rule 7), FDH10-A/B (architecture), the two headline financial controls (C-D... the decomposition/double-count engines), and FDH10-J (the bridge extension) were prioritised first, and given the scope of the remaining spec (150+ certification scenarios, live-DEV browser journeys, scale testing), building a genuine, working UI on top of an extraction pipeline that itself has no per-institution parsers yet (see `FDH10_REUSE_AND_GAP_AUDIT.md`'s disclosed gap) would have produced either (a) a UI wired to a fabricated/stub extraction result, misrepresenting completeness, or (b) additional weeks of per-institution parser work outside this pass's realistic budget. The engine, adapter, RPC, and security model — the parts of FDH10-K's own compare/apply UX that carry actual financial-integrity risk — are complete and independently certified; the presentation layer on top of them is the disclosed gap.

## What would be needed to complete this (for a follow-up pass)

1. `app/api/financial-data-hub/liability-statement/[documentId]/{process,proposal,approve}/route.ts` — mirroring the three payslip routes.
2. `app/api/liability-proposals/[proposalId]/apply/route.ts` — calling `applyLiabilityProposalAtomic()` (already written).
3. `components/liabilities/LiabilityStatementImportPanel.tsx` — mirroring `PayslipImportPanel.tsx`.
4. A per-institution (or at minimum generic-CSV-with-column-mapping-UI) extraction entry point, since `csvExtraction.ts` currently requires the caller to supply an explicit `LiabilityCsvColumnMap` rather than inferring it.
