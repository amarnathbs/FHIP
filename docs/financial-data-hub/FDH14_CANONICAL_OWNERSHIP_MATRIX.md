# FDH-14 — Canonical Data Ownership Matrix

FRESH FDH-14 EXECUTION: re-derived from current source (`lib/import-bridge/`, `lib/investment-import-bridge/`,
`lib/financial-data-hub/`) rather than transcribed from a prior module's description.

| Domain | FDH evidence owner | Canonical owner (table) | Allowed Apply path | Prohibited direct-write path |
|---|---|---|---|---|
| Income | FDH-9 (`fdh_payroll_events`, payslip evidence) | `income_sources` | `lib/import-bridge/applyIncomeProposalAtomic.ts` → RPC `fdh9_apply_income_proposal()` (SECURITY DEFINER, one transaction: ownership + staleness + allow-list + mutation + audit + proposal transition) | Any direct PostgREST `PATCH`/`POST` to `income_sources.source_type` / `.last_import_application_id` / `.last_imported_at` — blocked live by `fdh9_income_sources_assert_provenance_write()` trigger, freshly re-confirmed by this pass. |
| Expense / approved financial activity | FDH-7/FDH-8/R8 (`fdh_bank_transactions`, `fdh_transaction_links`, `fdh_transaction_allocations`) | The **Approved Financial Summary** computed by `lib/financial-data-hub/domain/approvedSummary.ts` (a read-time aggregation, not a second canonical expense table) | Approval (`approved_by` stamp) via FDH-7's approval service is the only thing that moves a transaction from evidence into the approved aggregate. | Any code path that reads `fdh_bank_transactions` without filtering on approval status; pending/duplicate/transfer rows are structurally excluded from the aggregate, not merely hidden in the UI. |
| Liabilities | FDH-10 (`fdh_liability_statements`, `fdh_liability_statement_transactions`) | `liabilities` | `lib/import-bridge/applyLiabilityProposalAtomic.ts` → RPC `fdh10_apply_liability_proposal()` | Direct write to `liabilities.source_type` / `.last_import_application_id` / `.last_imported_at` — blocked live by `fdh10_liabilities_assert_provenance_write()`, freshly re-confirmed by this pass. |
| Investments (Australia) | FDH-11 (`fdh_investment_statements`, `fdh_investment_statement_activities`, `fdh_investment_statement_positions`) | `ii_transactions` / `ii_holding_snapshots` (Investment Intelligence's own schema — **not** the legacy `investments` table, which FDH-11 never writes) | `lib/investment-import-bridge/applyAuStatementActivity.ts`, `applyAuStatementPosition.ts` | Any write to `investments` from an FDH-11 code path (there is none — confirmed by source inspection: FDH-11's bridge targets `ii_*` tables exclusively). |
| India Investments | Existing India module (Investment Intelligence's India adapters, R2/R6/R12) | `ii_transactions` / `ii_holding_snapshots` (same jurisdiction-agnostic schema, India-specific adapters only) | Investment Intelligence's own certified apply paths (R2–R12), unchanged by FDH-14. | FDH-11 adding any India-specific parser/holdings/cost-basis/security-master logic — verified 0 by source inspection (see `FDH14_JURISDICTION_CERTIFICATION.md`). |
| Retirement | FDH-12 (`fdh_retirement_statements`, `fdh_retirement_statement_activities`) | `retirement_accounts` (a **summary-balance register**, not an event ledger) | `lib/import-bridge/applyRetirementProposalAtomic.ts` → RPC (migration `0112`/`0113`) | Direct write to `retirement_accounts.source_type` / `.last_import_application_id` / `.last_imported_at` — blocked live by the migration-`0114` provenance guard, freshly re-confirmed by this pass. |
| SMSF | Existing SMSF module (migrations `0084`, `0089`, `0090`) | `smsf_funds` (SMSF's own summary table) | SMSF's own existing mutation path, unchanged. | FDH-12's `smsfDetection.ts` classifier explicitly never proceeds to any Apply — an SMSF-looking or ambiguous statement is always routed to review/rejection, never auto-imported (see FDH-12's own live proof, reused). |

## Architecture invariant proven by source inspection (fresh this pass)

Every "Apply" implementation found in the repository (`grep`-enumerated: `applyAuStatementPosition.ts`,
`applyAuStatementActivity.ts`, `lib/import-bridge/applyService.ts`, `applyRetirementProposalAtomic.ts`,
`applyLiabilityProposalAtomic.ts`, `applyIncomeProposalAtomic.ts`) is a **typed, domain-specific function**,
each calling either a named, migration-defined Postgres RPC or a narrow, domain-typed Supabase table write.
**Zero** generic "apply this arbitrary field to this arbitrary table" dynamic-write helper exists anywhere in
the FDH/import-bridge code — i.e. unsafe generic dynamic canonical writes = **0**, confirmed by source
inspection, not merely asserted.
