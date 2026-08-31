# FDH-15 — Bridge Architecture Inventory

FRESH FDH-15 EXECUTION: derived from six parallel read-only investigations of the actual current
source (migrations, `lib/import-bridge/`, `lib/investment-import-bridge/`,
`lib/financial-data-hub/`, `app/api/financial-data-hub/`) on this branch, not transcribed from
prior modules' descriptions. Every claim below is cited to a file or migration; see the discovery
transcripts referenced in each domain's own `FDH{9,10,11,12}_*` docs for line-level citations.

## Is there a shared proposal framework?

**Hybrid.** One shared generic schema — `fhip_import_proposals`, `fhip_import_proposal_fields`,
`fhip_import_applications` (all created once, migration `0091`) — backs Income, Liability, and
Retirement. Each domain's actual canonical mutation is a **separate, hand-written, statically-typed
SECURITY DEFINER RPC** (`fdh9_apply_income_proposal`, `fdh10_apply_liability_proposal`,
`fdh12_apply_retirement_proposal`), not one generic dynamic dispatcher — this is explicit, spec-cited
intent in the migrations' own comments (e.g. `0096:762-764`: "do NOT implement an arbitrary dynamic
table_name/column_name/SQL-from-client-data RPC — use a typed liability adapter").

AU Investments (FDH-11) diverges further: it does **not** use the generic proposal tables at all
(`FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md`, a documented ADR — `tableFor('investment')` in
`lib/import-bridge/supabaseStore.ts` throws by design). Instead the evidence rows themselves
(`fdh_investment_statements/_positions/_activities`) carry `apply_status`/`approval_status`
lifecycle columns, and canonical mutation happens via two typed library functions
(`applyAuStatementActivity.ts`, `applyAuStatementPosition.ts`) called from an API route using a
service-role client — there is **no end-user-invoked RPC** for Investment Apply. Authorization for
Investment Apply is therefore enforced at the **API-route layer** (`requireCountryConfirmedUser()`),
not at the RLS/RPC layer the other three domains use — a genuine architectural asymmetry, disclosed
here rather than hidden.

Expenses (FDH-7/8) uses **neither** mechanism — see the dedicated section below.

## Domain table

| Domain | Evidence source (table) | Proposal mechanism | Compare mechanism | Canonical target | Apply path | Provenance | Stale protection |
|---|---|---|---|---|---|---|---|
| **Income** (FDH-9) | `fdh_payroll_events` (payslip) + read-only bank-transaction cross-check | `fhip_import_proposals`/`_fields` (`target_domain='income'`) | `incomeAdapter.buildProposal()` field-by-field diff, read via `GET .../payslip/{id}/proposal` | `income_sources` | `lib/import-bridge/applyIncomeProposalAtomic.ts` → RPC `fdh9_apply_income_proposal()` (SECURITY DEFINER, `auth.uid()`-only) | `income_sources.source_type`/`.last_import_application_id`/`.last_imported_at`, guarded by `fdh9_income_sources_assert_provenance_write()` | Per-field value compare-and-swap against `fhip_import_proposal_fields.existing_value` (no `updated_at`/version column — deliberately, see `FDH9_REUSE_AND_GAP_AUDIT.md`) |
| **Expenses** (FDH-7/8) | `fdh_transactions` (bank evidence) | **No proposal table exists.** `'expense'` is a reserved-but-unimplemented value in the generic `target_domain` CHECK; zero expense-proposal routes/services exist. | N/A — approval IS the only user decision | The approved `fdh_transactions` row itself (`approval_status='approved'`), read live by FDH-8's Financial Activity engine; `fdh_approved_financial_summaries` is an aggregate rollup, not a per-row canonical copy | `approvalService.ts#approveTransaction()`/`#approveStatement()` — direct `UPDATE approval_status` on the same canonical row | N/A (no import provenance column; the transaction row's own `financial_account_id`/statement lineage is the provenance) | N/A — approval is idempotent (`approval_status` is a terminal flag) |
| **Liabilities** (FDH-10) | `fdh_liability_statements` + `_activities` | `fhip_import_proposals`/`_fields` (`target_domain='liability'`) | `liabilityAdapter.buildProposal()` field diff | `liabilities` | `lib/import-bridge/applyLiabilityProposalAtomic.ts` → RPC `fdh10_apply_liability_proposal()` | `liabilities.source_type`/`.last_import_application_id`/`.last_imported_at`, guarded by `fdh10_liabilities_assert_provenance_write()` | Same per-field compare-and-swap pattern as Income |
| **AU Investments** (FDH-11) | `fdh_investment_statements` + `_positions` + `_activities` | Lifecycle columns on the evidence rows themselves (`approval_status`, `apply_status`, `security_match_status`, `bank_match_status`) — no generic proposal row | `lib/investment-import-bridge/currentVsStatement.ts` (read-only, composes `ii_holding_snapshots` vs. statement evidence) | `ii_accounts`/`ii_instruments`/`ii_transactions`/`ii_holding_snapshots` (Investment Intelligence's own schema — same tables India uses) | `applyAuStatementActivity.ts` / `applyAuStatementPosition.ts`, called from `POST .../investment-statement/{id}/apply` using a service-role client; authorization enforced at the API-route layer, not RLS/RPC | `applied_at`/`applied_by`/`canonical_holding_snapshot_id`/`canonical_transaction_id` on the evidence row; `ii_transactions.transaction_fingerprint` (dedup key) | Compare-and-swap claim on `apply_status` (`pending→applying→applied`) + fingerprint/unique-index backstop on `ii_transactions`/`ii_holding_snapshots` |
| **Retirement** (FDH-12) | `fdh_retirement_statements` + `_activities` (+ terminal `_positions`, evidence-only) | `fhip_import_proposals`/`_fields` (`target_domain='retirement'`) | `retirementAdapter.buildProposal()` field diff | `retirement_accounts` (a summary-balance register, never an event ledger) | `lib/import-bridge/applyRetirementProposalAtomic.ts` → RPC `fdh12_apply_retirement_proposal()` | `retirement_accounts.source_type`/`.last_import_application_id`/`.last_imported_at`, guarded by `fdh12_retirement_accounts_assert_provenance_write()` (migration `0114`) | Same per-field compare-and-swap pattern, **plus** (new this round, migration `0119`) a household-member consistency check — see `FDH15_STALE_CONFLICT_CERTIFICATION.md` |
| **India Investments** | Existing India adapters (R2/R6/R12), unchanged by FDH-9–12 | Investment Intelligence's own certified apply paths | N/A (out of FDH-15 scope) | `ii_accounts`/`ii_transactions`/`ii_holding_snapshots` — **same tables as AU**, jurisdiction-scoped by adapter, not by a second schema | Unchanged by this round | Unchanged | Unchanged |
| **SMSF** | Existing SMSF module (migrations `0084`/`0089`/`0090`) | N/A | N/A | `smsf_funds`/`smsf_fund_members`/`smsf_holdings` — its own summary tables, FK'd to `retirement_accounts` | Unchanged; FDH-12's retirement Apply RPC explicitly refuses any SMSF-flagged target (`SMSF_ACCOUNT_NOT_IMPORTABLE`) before any mutation | Unchanged | Unchanged |

## Dynamic/unsafe canonical writes

**0 found.** Every place `target_domain` (or any proposal field name) is read, it drives a static
`if/elsif` chain naming **literal, hardcoded table names**; the only `EXECUTE format(...)` usage in
the apply RPCs builds column-name fragments via `%I`, but the column names are drawn from a
hardcoded allow-list array checked *before* interpolation, and the table name itself is always a
string literal. No `.from(<variable>)` pattern exists anywhere in the TypeScript bridge code either
— confirmed by repo-wide grep across all 111+ migrations and the `lib/import-bridge/`,
`lib/investment-import-bridge/` trees.

## Second canonical engine?

**0 found.** FDH-11's evidence tables carry no DB-level FK to any `ii_*` table and are structurally
enforced (by `tests/unit/fdh11Isolation.test.ts`) never to restate a canonical Investment
Intelligence entity. India and AU investment adapters write the identical `ii_*` schema. SMSF is a
wholly separate table tree, FK'd to (never duplicating) `retirement_accounts`.
