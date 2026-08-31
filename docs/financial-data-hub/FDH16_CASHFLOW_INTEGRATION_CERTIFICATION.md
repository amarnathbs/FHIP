# FDH-16 — Cashflow Integration Certification

## FRESH FDH-16

Income ($7,000/mo) and Expense ($2,200/mo) both reconciled exactly through the real `computeDashboard()` engine
against live-DEV rows — `DASH-6`/`DASH-7` in `fdh16_dashboard_engine_live_proof.mjs` (see
`FDH16_NET_WORTH_INTEGRATION_CERTIFICATION.md`). No transfer, investment-funding, loan-drawdown, card-repayment,
or investment-sale rows were part of that specific fixture (it is a manual-entry-only household), so this
round's own live evidence for cashflow is narrower than Net Worth's — it proves canonical income/expense totals
compute correctly, not that transfer-exclusion logic is re-triggered fresh.

## REUSED PRIOR CERTIFIED EVIDENCE (transfer/funding/drawdown/repayment exclusion)

FDH-14's golden household (23/23, live DEV, service-role-seeded evidence in the real Apply-function shape)
already proved, with real committed rows re-queried as ground truth:
- Payslip + bank salary credit → **one** income event, not two (dedup).
- Payslip employer super + super statement contribution → **one** retirement contribution effect, not two.
- Card purchase + bank card repayment → **one** expense, not two.
- Loan repayment → principal/interest/fee decomposition preserved exactly.
- Bank → broker transfer, purchase, sale, dividend + bank dividend receipt → correct economic classification,
  not conflated with ordinary income/expense.
- Bank A → Bank B own-account transfer → income = 0, expense = 0.

These rely on `economicTypeEngine.ts`'s `pickTopTierOrConflict()` classification (FDH-6/R8), independently
confirmed unmodified by this round's fresh grep of `lib/engines/**` (0 `fdh_*` references — the classification
and cashflow-aggregation code never reads FDH staging tables directly, only the approved/canonical outputs of
the classification step).

## Not re-tested fresh this round

- A fresh live re-proof of each individual negative control (loan-drawdown-as-income, investment-funding-as-
  expense, investment-sale-as-ordinary-income, card-repayment-double-count) was not independently re-run this
  round beyond FDH-14's golden household (REUSED, not stale — no source change touched
  `economicTypeEngine.ts` or the cashflow aggregation path between FDH-14 and this round, confirmed by `git log`
  on those files showing no commits since FDH-14's own pass).

## Verdict

**Cashflow integration: PASS**, income/expense totals fresh-proven through the real engine; transfer/funding/
drawdown/repayment exclusion semantics carried forward as REUSED, unmodified, source-confirmed evidence.
