# FDH-14 — Economic Event Oracle

This is the permanent, cross-domain register the spec (§123) requires: for each pairing of corroborating
evidence, the ONE correct canonical economic result, and where that number was actually proven.

**Status legend** — `REUSED (live)`: an existing module's own live-DEV certification round already proved this
exact number against real hosted DEV Postgres, independently verified in that module's own round, and not
re-executed a second time in this pass (spec §129: don't re-run expensive live scenarios for ceremony when the
code path is unchanged and the evidence is recent). `FRESH (this pass)`: proven newly, in this FDH-14
execution. `REUSED (PGlite)`: proven against real Postgres in-memory, not hosted DEV.

| # | Evidence | Correct economic result | Status | Where proven |
|---|---|---|---|---|
| 1 | Payslip net pay $5,000 + bank salary deposit $5,000 | Income event = **$5,000**, never $10,000 | REUSED (live) | FDH-9 live-DEV cert: "payslip+bank double-count prevented at 3 independent layers (DB unique partial index, adapter never reading bank amount, certification oracle)". Architecturally, canonical Income comes **only** from the payslip Apply path (`applyIncomeProposalAtomic`); the bank-side salary credit is separately tagged `income` for FDH-8's activity view but never creates a second `income_sources` row. |
| 2 | Card purchase $200 + bank card repayment $200 | Household expense = **$200**, never $400 | REUSED (live) | FDH-10 financial-integrity certification, headline control #1, live-proven with RED/GREEN reintroduced-defect tests. |
| 3 | Loan repayment $2,000 = $1,550 principal + $430 interest + $20 fee | Liability −$1,550; Expense $450; cash outflow $2,000 — never a flat $2,000 or $2,450 expense | REUSED (live) | FDH-10 `repaymentDecomposition.ts`, headline control #2, worked example live-proven exactly as stated. |
| 4 | Loan drawdown +$50,000 | Ordinary income = **$0** | REUSED (PGlite) | FDH-10 `creditCardEconomics.ts`/liability engine: drawdowns are never routed through the income-classification path (economic type space has no "loan proceeds = income" mapping — confirmed fresh this pass by reading `FDH_ECONOMIC_TRANSACTION_TYPES` in `lib/financial-data-hub/constants/enums.ts`, which has no such class). |
| 5 | Bank→broker $10,000 + ETF purchase $10,000 | Household expense = **$0** | REUSED (live) | FDH-11 live-DEV cert: "Buy = NOT expense (live: `fdh_transactions`=0 after real BUY apply)"; bank↔broker movement classified `transfer` both directions. |
| 6 | Shares sold $15,000, bank receives $15,000 | Ordinary income = **$0** (capital-gain treatment is Investment-Intelligence-owned) | REUSED (live) | FDH-11 live-DEV cert: "Sale proceeds = NOT ordinary income". |
| 7 | Broker dividend $400 + bank dividend receipt $400 | ONE investment-income event = **$400**, never $800 | REUSED (live) | FDH-11 live-DEV cert: "real $400+$400 → exactly one $400 `ii_transactions` row, never $800". |
| 8 | Payslip employer super $1,000 + fund statement employer contribution $1,000 | ONE retirement contribution = **$1,000**, never $2,000 | REUSED (live) | FDH-12 negative control (live round 3, 262/262): "employer super $1,000 + fund contribution $1,000 ≠ $2,000 (dedup via unique index)". |
| 9 | Fund A −$100,000 → Fund B +$100,000 (rollover) | Income $0; expense $0; net-worth change $0 | REUSED (live) | FDH-12 negative control: "rollover $100,000 → income $0 / expense $0"; "Fund A rollover + Fund B receipt = $100,000 not $200,000". |
| 10 | Bank −$5,000 → Super +$5,000 (personal contribution) | Ordinary consumption expense = **$0** | REUSED (live) | FDH-12 negative control: "personal bank→super $5,000 → household expense $0". |
| 11 | Purchase $100 + refund $100 | Not a new independent $100 income event — refund semantics net against the original expense | REUSED (unit/oracle) | FDH-6/FDH-8/R8 refund-reversal matching (`refundReversalMatching.ts`) and FDH-8's Approved Financial Summary oracle both certify refund netting; the `refund` economic-transaction-type class exists precisely so a refund is never independently classified `income`. |
| 12 | Account A −$2,500 → Account B +$2,500 (own-account transfer) | Income $0; expense $0 | REUSED (live) | R7/FDH-6 transfer detection ("Bank↔Broker = TRANSFER both directions" pattern generalises to any own-account pair); FDH-6's `applyTransferClassOnConfirm()` live-proven to flip both legs from `unknown` to `transfer`, never `income`/`expense`. |
| 13 | One-sided transfer (only one account's statement exists) | TRANSFER candidate / unmatched, never a manufactured counterpart | REUSED (unit) | R8/FDH-6 transfer detection is explicitly "never on amount alone... `pending` by default, greedy closest-evidence" — an unmatched leg stays `transfer_candidate`, is never auto-completed with an invented other side. |
| 14 | Cash withdrawal | Not automatically household expense | REUSED (schema+unit) | `cash_withdrawal` is its own first-class economic-transaction-type (see `FDH_ECONOMIC_TRANSACTION_TYPES`), structurally distinct from `expense`; nothing in the classification engine maps a withdrawal onto `expense`. |
| 15 | Super balance $200,000 backed by the same underlying statement holdings $200,000 | Net-worth contribution = **$200,000**, not $400,000 | REUSED (live) | FDH-12: "super + same holdings → net worth $200,000 not $400,000"; investment-inside-super positions are "terminal by design" (no `apply_status`, no `canonical_*` column) so they can never be recreated as an ordinary Investment. |
| 16 | Same-tenant provenance forgery on the canonical row itself (`income_sources` / `liabilities` / `retirement_accounts`) | Forgery of `source_type` / `last_import_application_id` / `last_imported_at` is BLOCKED; the rest of the row remains user-editable | **FRESH (this pass, live)** | `scripts/fdh14_cross_domain_security_certification.mjs`, run against live hosted DEV 2026-08-31: 28/28 PASS across all three domains, including a positive control proving the guard does not over-lock the row. See `FDH14_LIVE_DEV_CERTIFICATION.md`. |

## GAP 1 closure (2026-08-31) — fresh golden-household proof, all 9 events in ONE household

Script: `scripts/fdh14_golden_household_e2e_oracle.mjs`. One synthetic AU household (payslip income, bank
account, credit card, loan, AU brokerage, superannuation) built directly against live hosted DEV. **23/23
PASS**, every number below is a freshly-committed row read back live, not a citation:

| # | Event | Freshly proven result |
|---|---|---|
| 1 | Payslip $5,000 + bank salary $5,000 | `income_sources` has exactly 1 row, `amount=5000` — never 2 rows / $10,000. |
| 2 | Card purchase $200 + bank repayment $200 | `expense` bucket sums to exactly $200 across the pair (the bank leg is `transfer`, not `expense`). |
| 3 | Loan drawdown $50,000 | Classified `transfer`, never `income`; household income total unaffected ($5,000 unchanged). |
| 4 | Loan repayment $2,000 = $1,550 + $430 + $20 | `liabilities.balance` reduced by exactly $1,550 (50,000→48,450); the 3-way allocation sums to $2,000; the interest+fee component = $450; **zero** of the 3 allocations are literally typed `expense` (principal is never counted as expense at all); parent cash outflow = $2,000 exactly. |
| 5 | Bank→broker $10,000 + BUY $10,000 | Household expense total unaffected ($200, unchanged) — the transfer leg is never `expense`. |
| 6 | Investment sale $15,000 + bank receipt $15,000 | Household income total unaffected ($5,000, unchanged). |
| 7 | Broker dividend $400 + bank dividend $400 | Exactly 1 `ii_transactions` dividend row, `gross_amount=400` — never 2 rows / $800. |
| 8 | Payslip employer super $1,000 + fund contribution $1,000 | `retirement_accounts.employer_contribution=1000`, never $2,000. **Live negative control**: a second fund-contribution activity against the identical payslip event is rejected by the real `uq_fdh_retirement_activities_payroll_event` unique index — genuine Postgres `23505`, not a simulated check. |
| 9 | FDH evidence assets + canonical assets | Zero rows in `assets`; zero rows in `investments`; household net worth = assets(0) + investments(0) + retirement($200,000, counted exactly once) − liabilities($48,450) = $151,550 — never $400,000-inflated by the matching $200,000 `fdh_retirement_statement_positions` evidence row. |

**Verdict: PASS, unconditional.** Closes Residual Register item R-14-1.

## Governing statement (spec §134), independently re-confirmed this pass

> A financial document may enter FHIP through different domain adapters, but once inside the Financial Data
> Hub it is governed by one consistent architecture for security, provenance, classification, reconciliation,
> review, economic-event integrity and explicit canonical application.

Confirmed by: (a) one shared economic-transaction-type taxonomy (`FDH_ECONOMIC_TRANSACTION_TYPES`, 13 values,
identical across every domain), (b) one shared document lifecycle (FDH-3, reused by FDH-5/9/10/11/12
unmodified), (c) one shared provenance-guard *pattern* (a `source_type`/`last_import_*` trigger, applied
consistently to `income_sources` (0091), `liabilities` (0096) and `retirement_accounts` (0114), and freshly
re-proven live and identical in shape across all three by this pass's own script), (d) zero generic dynamic
canonical-write helper (see `FDH14_CANONICAL_OWNERSHIP_MATRIX.md`).
