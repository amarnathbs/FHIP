# LR-5 — SMSF Entity Workspace Foundation: Phase Report

**As of:** 2026-09-08

## 1. Terminal Verdict

**CONDITIONAL PASS — the SMSF workspace is already genuinely built, reachable, and correctly hardened. No code change was made this phase, per the pack's own "prove it, don't change it" instruction. Two real, substantial gaps are documented and deliberately deferred rather than risked as an unscoped refactor.**

## 2. Discovery Truth Map (WP-01 — existing SMSF foundation audit)

A full, reachable, multi-part SMSF workspace already exists, embedded as a section on the Retirement page (`app/(app)/retirement/page.tsx:44` renders `SmsfSection`), not a separate top-level route — correctly matching this phase's own lock ("SMSF belongs under Retirement, not as a new top-level main navigation module").

| Layer | Status |
|---|---|
| Fund creation, Summary-mode balance editing | Live and connected (`SmsfSection.tsx`, `SmsfFundCard.tsx`) |
| Members (Self/Spouse, interest allocation) | Live and connected (`SmsfMembers.tsx`, reuses the pre-existing `retirement_members` table) |
| Detailed Holdings (add/edit/remove, 19 typed holding categories) | Live and connected (`SmsfDetailedWorkspace.tsx`, `SmsfHoldingForm.tsx`) |
| Associated Debt | Live and connected — genuinely reuses the certified `property_liability_links` table via a reserved `link_type='smsf_property_loan'`, not a parallel mechanism |
| Summary ↔ Detailed mode switch | Live and connected, with a real reconciliation panel and hard DB-level guards (see below) |
| All 9 `app/api/smsf/*` routes | Every one has a confirmed UI caller — no orphaned/backend-only routes found |
| RLS | Confirmed via direct migration read: `auth.uid() = user_id` on `smsf_funds`/`smsf_fund_members`/`smsf_holdings`, plus cross-reference checks preventing a forged fund/member ID from another tenant |

**Summary/Detailed mutual exclusivity** (a standing Product Owner ruling) is enforced at the database level, not just in UI logic — the single most load-bearing finding of this audit:
- `smsf_switch_to_detailed()` raises an exception and blocks the switch unless the computed Detailed net value equals the Summary balance to the cent.
- `retirement_accounts_smsf_balance_guard` (migration `0090`) is a defence-in-depth trigger blocking any *other* write path (a generic grid PATCH, a direct PostgREST call) from touching an SMSF fund's `current_balance` — added specifically because an earlier pass found the merged UI code had no such guard. This is exactly the class of protection this whole programme exists to verify actually holds, not just assume from a component existing.

## 3. What is genuinely absent (not gaps in what exists — gaps the pack's own WP-03 asks about)

1. **No generic entity-context (`entity_id`/`entity_type`) contract.** The shared Income/Expenses/Assets/Liabilities grid (`FinancialDataGrid.tsx`) does not have an "SMSF mode" — SMSF is deliberately *excluded* from it entirely (`excludeMasterItemKeys: ['smsf']` in `retirementGridConfig`). Reuse instead happens through **narrow, purpose-built integration points**: the SMSF workspace reads/writes `retirement_accounts.current_balance` (via the DB triggers above), reuses `retirement_members`, and reuses `property_liability_links` — real reuse of certified data, just not via one unified generic parameter threaded through every shared module.
2. **No SMSF bank-statement/transaction import.** FDH-12 (LR-3/LR-4's own ingestion pipeline) explicitly *detects and routes away* SMSF statements rather than importing them (`smsfDetection.ts`'s `routed_to_smsf`/`possible_smsf` classifications both block approval, enforced by migration `0112` PART H). All SMSF holdings data entry is manual through `SmsfHoldingForm`.

## 4. Why no code was written for either gap this phase

Building a genuine, generic entity-context abstraction that lets *every* shared grid/import engine operate correctly in "SMSF mode" is a substantial, cross-cutting architectural undertaking — touching `FinancialDataGrid.tsx` (already just rewritten in LR-2), every grid config, and every relevant API route's authorization logic. Attempting it without explicit scoping risk directly contradicts this phase's own lock: "Do not create a second SMSF balance sheet" — a careless generic-context refactor is exactly the kind of change that could accidentally let a shared module write an SMSF value through an unguarded path, undermining the very `retirement_accounts_smsf_balance_guard` protection item 2 above confirmed exists specifically because that failure mode happened once already. The current narrow, purpose-built integrations (property-liability linking, retirement_members reuse) already satisfy the phase's actual primary objective — "reuses existing household financial modules... without rebuilding a parallel finance application" — without that risk.

Similarly, wiring SMSF bank-statement import would mean reversing FDH-12's own explicit, tested, migration-enforced boundary (`routed_to_smsf` blocking approval) — a deliberate prior design decision, not an oversight, and reversing it is squarely a Product Owner decision, not something to do opportunistically inside an LR-5 verification pass.

Both are recorded as real, named, deferred items rather than silently left unmentioned.

## 5. Financial/Data Contract

No changes. This was a verification-only phase.

## 6. Regression / Typecheck / Lint / Build

Not run — no files were changed this phase.

## 7. Live DEV / Production

Not independently re-verified this phase beyond the discovery agent's direct code/migration reads (which included tracing every API route to a confirmed UI caller and reading the actual RLS/trigger SQL, not just component existence). No live browser walkthrough of the SMSF workspace was performed in this session.

## 8. Deferred Findings

| Finding | Owner/Phase | Why not blocking |
|---|---|---|
| No generic entity-context abstraction for shared modules | A future, explicitly-scoped phase, only with Product Owner authorization for the refactor's blast radius | The current narrow integration points already achieve real reuse without a parallel balance sheet; a generic refactor is high-risk and out of this phase's safe scope |
| No SMSF bank-statement import | A future phase, only with an explicit Product Owner decision to reverse FDH-12's current deliberate exclusion | FDH-12's routing-away behaviour is tested, migration-enforced, deliberate — not a bug to opportunistically fix |
| No live browser walkthrough performed this phase | LR-5 follow-up, or folded into LR-6's SMSF work | Discovery was thorough at the code/migration level (every route traced to a real caller, RLS read directly); this is a real coverage gap in *evidence type*, not a known defect |

## 9. Next-Phase Readiness

**Yes, LR-6 may proceed.** LR-6 (SMSF P&L, Reconciliation, Forecast & Accountant/Auditor Export) builds on the same `smsf_funds`/`smsf_holdings`/`smsf_fund_members` foundation this phase confirmed is solid; LR-6's own discovery will need to separately assess what P&L/export capability, if any, already exists.
