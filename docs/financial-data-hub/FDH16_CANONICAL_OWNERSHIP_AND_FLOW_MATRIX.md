# FDH-16 — Canonical Ownership and Flow Matrix

Base table REUSED from `FDH14_CANONICAL_OWNERSHIP_MATRIX.md` (fresh source re-derivation at the time of FDH-14),
extended here with the downstream-consumer column FDH-16 specifically requires (§14/§242), fresh-verified by
this round's own grep sweep (see `FDH16_FULL_INTEGRATION_ARCHITECTURE.md`).

| Domain | FDH evidence owner | Canonical owner (table) | Apply path | Downstream consumers (fresh-confirmed this round) | Fresh test this round |
|---|---|---|---|---|---|
| Income | FDH-9 (`fdh_payroll_events`) | `income_sources` | `fdh9_apply_income_proposal()` RPC | Dashboard (`computeDashboard`), Forecasting, Reports, Scores/DNA/Resilience/Twin (all via canonical table only — 0 `fdh_*` reads) | Manual-vs-import script (`fdh16_manual_vs_import_equivalence_certification.mjs`, I-1..I-1c, CMP-1) |
| Expense / Approved Financial Activity | FDH-7/8/R8 (`fdh_bank_transactions` etc.) | Approved Financial Summary (`lib/financial-data-hub/domain/approvedSummary.ts`, read-time aggregation) + `expense_items` for manual entries | FDH-7 approval service | Dashboard, Reports | REUSED (FDH-8/10 certification); Dashboard engine proof confirms `expense_items` reconciles (DASH-7) |
| Liabilities | FDH-10 (`fdh_liability_statements`) | `liabilities` | `fdh10_apply_liability_proposal()` RPC | Dashboard, Forecasting, Reports | Manual-vs-import script (I-2..I-3c, CMP-2) |
| AU Investments | FDH-11 (`fdh_investment_statements`) | `ii_transactions`/`ii_holding_snapshots`, published into `investments` via Investment Intelligence's own publishing step | `applyAuStatementActivity.ts`/`applyAuStatementPosition.ts` | Dashboard (via `investments` table), Investment Intelligence's own screens | REUSED (FDH-11/FDH-14 certification; not re-run fresh this round — no real bridge RPC reachable outside the running app server) |
| India Investments | Existing India module (II R2/R6/R12 adapters) | `ii_transactions`/`ii_holding_snapshots` (jurisdiction-agnostic schema) | Investment Intelligence's own certified apply paths | Same as AU Investments | REUSED (FDH-11/FDH-14 jurisdiction certification: 0 new FDH India shadow engine, confirmed by source inspection) |
| Retirement | FDH-12 (`fdh_retirement_statements`) | `retirement_accounts` (summary-balance register, not an event ledger) | `fdh12_apply_retirement_proposal()` RPC | Dashboard, Forecasting, Reports | Manual-vs-import script (I-4..I-5d, CMP-3) |
| SMSF | Existing SMSF module (migrations `0084`/`0089`/`0090`) | `smsf_funds` | SMSF's own mutation path | Retirement summary (via existing SMSF-aware queries) | REUSED — FDH-12's `smsfDetection.ts` never auto-applies (source-confirmed, not re-tested fresh this round) |
| Goals | N/A (no FDH evidence path) | `user_goals`, `goal_snapshots` | Manual/goal-linkage APIs only | Reports, Forecasting | Fresh grep: `lib/engines/**` contains 0 `fdh_*` references — Goals structurally cannot read FDH evidence |
| Household/Member | Mandatory Country Confirmation (`user_profiles`), `retirement_members`/`owner` columns | `user_profiles`, `households`, `retirement_members` | Onboarding + MCC triggers | All domains (Self/Spouse attribution) | REUSED (FDH-15's `INC-6`/`RET-2` fix, DEV-confirmed); this round's own scripts used country-confirmed synthetic users throughout with 0 friction, confirming MCC does not obstruct legitimate bridge/manual flows |

## Architecture invariant (REUSED, source-reconfirmed)

Every "Apply" implementation is a typed, domain-specific function or a named migration-defined RPC. Zero
generic "apply this arbitrary field to this arbitrary table" dynamic-write helper exists anywhere in the
FDH/import-bridge code (source-inspection finding from FDH-14, not contradicted by anything found this round).
