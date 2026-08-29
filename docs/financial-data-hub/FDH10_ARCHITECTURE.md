# FDH-10 — Architecture

## Data flow

```
Credit Card / Loan Statement
  -> FDH-3 secure document lifecycle (fdh_statement_uploads, reused)
  -> CSV extraction (lib/financial-data-hub/liability/csvExtraction.ts — generic adapter only, see gap audit)
  -> fdh_liability_statements + fdh_liability_statement_activities (NEW, this phase)
  -> Economic classification:
       - creditCardEconomics.ts  (purchases/refunds/cash-advances/interest/fees)
       - repaymentDecomposition.ts (loan payment -> principal/interest/fee split)
  -> Bank-payment matching (bankMatching.ts) against existing fdh_transactions
  -> Ledger write: NEW fdh_transactions row (purchase/interest/fee/cash-advance)
       OR fdh_transaction_allocations split on an EXISTING matched bank row
       (loan repayment decomposition) — never a duplicate of an existing row
  -> Facility matching (facilityMatching.ts) against existing `liabilities`
  -> lib/import-bridge/adapters/liabilityAdapter.ts builds an
     ImportProposalDraft (target_domain='liability')
  -> User review: Current Liability vs Statement Proposal
  -> USER APPLY -> fdh10_apply_liability_proposal() RPC (migration 0096, one
     atomic transaction) -> canonical `liabilities` row created/updated
```

## New tables (migration 0096)

- **`fdh_liability_statements`** — one row per parsed statement: institution, facility type, statement period/dates, balances, reconciliation outcome, review/approval state, duplicate/supersession links. Analogous to FDH-9's `fdh_payroll_events`.
- **`fdh_liability_statement_activities`** — one row per line item: `activity_type` (`PURCHASE`/`REFUND`/`PAYMENT`/`CASH_ADVANCE`/`INTEREST`/`FEE`/`PRINCIPAL`/`LOAN_ADVANCE`/`ADJUSTMENT`/`OTHER`), amount, optional principal/interest/fee decomposition components, and `linked_transaction_id` — the **single** bridge back to the canonical `fdh_transactions` ledger.

Both tables carry the same-tenant ownership trigger + authoritative-write trigger pattern established by migration 0091.

## Why no new "economic ledger"

Card purchases, refunds, cash advances, interest and fees are written as ordinary `fdh_transactions` rows on the card's own `fdh_financial_accounts` row (`account_type='credit_card'`), classified with the pre-existing `economic_transaction_type` vocabulary. Loan repayment decomposition reuses `fdh_transaction_allocations` — the exact split-transaction mechanism FDH-1 built for "one supermarket debit may be part groceries, part household goods" — applied to a loan's principal/interest/fee split instead. `fdh_liability_statement_activities.linked_transaction_id` is the only new relationship; there is no second transaction table, no second classification column, no second review-state machine.

## Why the bridge, not a new proposal system

FDH-9's `fhip_import_proposals`/`fhip_import_proposal_fields`/`fhip_import_applications` were built with `target_domain` as a widen-only column and `'liability'` already a member of its check constraint. FDH-10 adds:
- a `liabilityAdapter.ts` implementing the same `ImportDomainAdapter<TEvidence, TExisting>` contract `incomeAdapter.ts` implements;
- a `liability` branch inside the existing same-tenant guard functions (`fdh9_assert_proposal_owner`, `fdh9_assert_application_owner`) via `create or replace function`;
- a typed `fdh10_apply_liability_proposal()` RPC, mirroring `fdh9_apply_income_proposal()`'s exact structure (row lock, compare-and-swap, staleness gate, allow-listed columns, single transaction) — not a generic dynamic-table RPC.

## Property↔Liability preservation

No FDH-10 file references `property_liability_links`. Facility matching (`facilityMatching.ts`) operates purely on institution/type/masked-identifier/currency identity — a mortgage already linked to a property is matched and updated as a facility exactly like any other liability; the existing property relationship is structurally untouched because nothing in the new code path can see or write it.

## Component inventory

| File | Role |
|---|---|
| `lib/financial-data-hub/liability/types.ts` | Domain vocabulary (facility types, activity types, statuses) |
| `lib/financial-data-hub/liability/csvExtraction.ts` | Generic column-mapped CSV -> `LiabilityStatementExtraction` |
| `lib/financial-data-hub/liability/statementReconciliation.ts` | Card/loan balance reconciliation formulas |
| `lib/financial-data-hub/liability/repaymentDecomposition.ts` | The loan headline control |
| `lib/financial-data-hub/liability/creditCardEconomics.ts` | The card headline control |
| `lib/financial-data-hub/liability/bankMatching.ts` | Statement-payment <-> bank-transaction matching |
| `lib/financial-data-hub/liability/facilityMatching.ts` | Statement <-> existing Liability matching |
| `lib/import-bridge/adapters/liabilityAdapter.ts` | The bridge's liability domain adapter |
| `lib/import-bridge/applyLiabilityProposalAtomic.ts` | Production apply path (calls the RPC) |
| `supabase/migrations/0096_...sql` | Schema, triggers, RPC |
