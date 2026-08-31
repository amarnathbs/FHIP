# FDH-15 — Cross-Domain Financial Integrity

REUSED EVIDENCE (primary): FDH-14's `fdh14_golden_household_e2e_oracle.mjs` (23/23 PASS, live DEV,
2026-08-31) and `FDH14_ECONOMIC_EVENT_ORACLE.md`/`FDH14_CROSS_DOMAIN_DEDUP_CERTIFICATION.md` already
built and live-proved every cross-document dedup scenario this spec names, on the exact same bridge
code this pass inspected fresh (no code change touched the economic-classification/allocation layer
this round — only the two Apply RPCs' target-validation logic changed, which this scenario set does
not exercise). Re-running an unchanged code path would not add certainty; the results are cited
below with their exact evidence, not merely asserted.

## 1. Results (from FDH-14's golden household, reused)

| Scenario | Required outcome | Live result |
|---|---|---|
| Salary: payslip $5,000 + bank $5,000 | ONE $5,000 income event | Exactly 1 `income_sources` row, total $5,000 (not $10,000); bank-side credit recorded separately as its own cash-flow row, never folded into income |
| Credit-card purchase $200 + bank repayment $200 | ONE $200 expense | Household expense total = $200 (not $400); bank-side settlement leg classified `transfer`, linked via `fdh_transaction_links` (`credit_card_settlement`) |
| Loan drawdown $50,000 | NOT income | Ordinary income total unaffected ($5,000, unchanged); drawdown transaction classified `transfer` |
| Loan repayment $2,000 = $1,550 principal + $430 interest + $20 fee | Liability balance -$1,550; expense component = $450 (interest+fee only) | `liabilities.balance` 50000→48450 exactly; 3-way allocation sums to exactly $2,000; **zero** allocations literally typed `expense` (principal is never counted as an expense at all) |
| Bank→broker $10,000 + BUY $10,000 | NOT a consumption expense | Household expense total unaffected (still $200); bank-side leg classified `transfer` |
| Investment sale $15,000 + bank receipt $15,000 | NOT ordinary income | Ordinary income total unaffected (still $5,000) |
| Broker dividend $400 + bank receipt $400 | ONE $400 investment-income event | Exactly 1 `ii_transactions` dividend row, total $400 (not $800) |
| Payslip employer super $1,000 + fund contribution $1,000 | ONE $1,000 contribution | `retirement_accounts.employer_contribution` = $1,000 (not $2,000); **negative control**: a second fund-contribution activity against the SAME payslip event is live-BLOCKED by a real DB unique index (`23505`), not merely application logic |
| FDH evidence assets + canonical assets | No net-worth duplication | `assets`/`investments` legacy tables: 0 rows created by FDH-11/12 evidence; net worth counts the $200,000 super balance exactly once (retirement_accounts.current_balance), not twice via the matching `fdh_retirement_statement_positions` evidence total |

## 2. Rollover, refund, unrelated-domain isolation

- **Rollover neutrality**: FDH-12's own architecture (reused, `FDH12_RETIREMENT_BRIDGE.md`) — a
  rollover activity has no canonical destination beyond the summary-balance update on the receiving
  account; it is structurally impossible for it to also register as income, expense or a second
  net-worth asset (no code path posts a retirement activity anywhere but the evidence table itself).
- **Refund semantics**: FDH-7/8's approved-transaction model (reused) preserves a refund's own
  `economic_transaction_type`; the bridge (Income/Liability/Retirement) never touches
  `fdh_transactions` classification at all, so refund semantics cannot be altered by any FDH-15
  bridge Apply.
- **Unrelated-domain isolation**: FDH-14's golden household proves Income Apply (Event 1) did not
  perturb the Liability/Investment/Retirement balances seeded before it, and each subsequent event's
  check re-confirms the PRIOR events' totals are unchanged (e.g. Event 3's check re-verifies income
  is still exactly $5,000) — a running isolation proof across all 9 events, not just a final snapshot.

## 3. Absence is not deletion (spec sections 172-178)

No code path in any Apply RPC issues a `DELETE` against a canonical table, nor does any RPC "replace
a snapshot" — every mutation is a targeted `UPDATE`/`INSERT` of specifically selected fields/rows
(confirmed by source inspection of all three RPCs' bodies: zero `DELETE FROM income_sources|
liabilities|retirement_accounts` statements exist). A statement missing a previously-held position/
account cannot cause a deletion, because deletion is not a code path the bridge has at all.

## 4. Forecasting/Goals boundary

Not independently re-verified live this pass (no code in Forecasting/Goals was touched or found
relevant to the two fixes made). REUSED from FDH-14's own `FDH14_JURISDICTION_CERTIFICATION.md`/
completion report, which found Forecasting reads only canonical registers (never evidence/proposal
tables) and Goals' funding-source links survive an Apply that updates an existing account (the
Apply RPCs never touch `goal_funding_sources` or any goal table).
