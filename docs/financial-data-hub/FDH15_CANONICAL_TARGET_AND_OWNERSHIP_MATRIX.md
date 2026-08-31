# FDH-15 — Canonical Target and Ownership Matrix

Updates FDH-14's `FDH14_CANONICAL_OWNERSHIP_MATRIX.md` with FDH-15's bridge-governance findings.
Re-verified fresh against current source this round, not copied.

| Domain | FDH evidence owner | Proposal owner | Canonical data owner | Authorized Apply mechanism |
|---|---|---|---|---|
| Income | FDH-9 (`fdh_payroll_events`) | `fhip_import_proposals` (`target_domain='income'`) | `income_sources` | `fdh9_apply_income_proposal()` RPC only |
| Expenses | FDH-7/8 (`fdh_transactions`) | N/A (no proposal stage) | The approved `fdh_transactions` row itself | `approvalService.ts` (direct `approval_status` flip, same row) |
| Liabilities | FDH-10 (`fdh_liability_statements`) | `fhip_import_proposals` (`target_domain='liability'`) | `liabilities` | `fdh10_apply_liability_proposal()` RPC only |
| AU Investments | FDH-11 (`fdh_investment_statements`) | Lifecycle columns on the evidence row (no generic proposal) | `ii_accounts`/`ii_transactions`/`ii_holding_snapshots` | `applyAuStatementActivity.ts`/`applyAuStatementPosition.ts`, invoked only from the authenticated API route |
| Retirement | FDH-12 (`fdh_retirement_statements`) | `fhip_import_proposals` (`target_domain='retirement'`) | `retirement_accounts` | `fdh12_apply_retirement_proposal()` RPC only |
| India Investments | Existing India II adapters | Investment Intelligence's own | `ii_accounts`/`ii_transactions`/`ii_holding_snapshots` (same tables as AU) | Unchanged, own certified apply paths |
| SMSF | Existing SMSF module | N/A | `smsf_funds`/`smsf_fund_members`/`smsf_holdings` | Unchanged; explicitly refused by FDH-12's retirement Apply RPC |

## Canonical target matching — deterministic, domain-appropriate, never balance-alone

Confirmed by direct source inspection (not merely asserted) for every domain that generates a
proposal:

- **Income**: employer-name folding (`foldEmployer()` — lowercase, punctuation-stripped,
  legal-suffix-stripped) against `income_sources.employer_name`/`source_name`, restricted (as of
  this round's fix) to `owner='self'` candidates. `amount` never appears as a match predicate.
- **Liability**: two-tier — masked identifier first (within the same `debt_type` + `currency_code`),
  institution name second, with an explicit fallback-pool restriction that excludes any candidate
  already carrying a *different* masked identifier (the FDH-10 defect this project's history
  already fixed). Balance/amount is structurally absent from the match-query type.
- **AU Investment**: ISIN (global) then ASX ticker (country-scoped) for securities; no fuzzy-name
  tier exists at all. FDH-11 never creates a security except via Investment Intelligence's own
  `resolveOrCreateInstrument()`, and only on explicit user confirmation.
- **Retirement**: jurisdiction+currency hard filter → masked identifier → fund/institution name →
  account-type tie-break, with household-member narrowing before any of the above. `current_balance`
  is mechanically absent from the matcher (a build-time isolation test fails if `balance` appears in
  the matching module).

## Self/Spouse boundary — now enforced at BOTH layers

Before this round, member/owner separation for Retirement was enforced only at
**proposal-generation time** (the typed matcher never offers a cross-member candidate) — the
authoritative Apply RPC itself had no independent check. This round's live-DEV negative control
(spec §30/§81/§197) proved that gap was real and exploitable (FDH15-DEF-002); migration `0119` adds
a defense-in-depth `MEMBER_MISMATCH` guard directly in `fdh12_apply_retirement_proposal()`. The
identical class was found and fixed for Income (FDH15-DEF-001, migration `0120`) — see
`FDH15_RESIDUAL_RISK_REGISTER.md` for full defect records.

## India Investment boundary (spec §20)

India investment canonical data is **not** rewritten through the AU FDH-11 bridge: FDH-11's
evidence tables carry no FK to `ii_*`, its security matcher only ever resolves ISIN/ASX-ticker
identifiers, and `tests/unit/fdh11Isolation.test.ts` mechanically fails the build if FDH-11 code
references any Investment Intelligence entity restatement. India investment bridge duplication = **0**.

## SMSF boundary (spec §21)

FDH-12's retirement Apply RPC checks `v_account.master_item_key = 'smsf' OR EXISTS (SELECT 1 FROM
smsf_funds WHERE retirement_account_id = v_account.id)` **before** any staleness/mutation work and
refuses with `SMSF_ACCOUNT_NOT_IMPORTABLE`. `ADD NEW` always inserts `master_item_key = NULL`, so a
statement import cannot create a new SMSF-flagged row either. Duplicate SMSF representation = **0**.
