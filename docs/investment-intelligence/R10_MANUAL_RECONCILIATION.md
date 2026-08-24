# II-R10 — Manual Reconciliation

**Status: 12/12 PASS (terminal closure round).**

Superseded the "NOT RUN" state this file previously recorded. The
terminal closure round built `scripts/r10_manual_reconciliation.mjs`
(seeds one disposable user with known, hand-computable values across cash
flow, net worth, goals, retirement, and all 4 Investment Intelligence
modules — R4 Performance, R5 SIP, R5 X-Ray, R6 Tax — plus Review Centre,
then generates one real Premium report through the real app) and
`scripts/r10_mr_verify.mjs` (independently re-derives each case's
expected value from the known seed inputs — including a from-scratch
hand-computed portfolio value replicating the exact NAV-compounding
formula for the Performance/X-Ray cases, not a read-back of the report's
own numbers — and compares against the persisted `report_sections`
snapshot).

| # | Case | Domain | Expected (independently derived) | Actual (report) | Result |
|---|---|---|---|---|---|
| MR01 | Gross monthly income | Free / Cash Flow | 150,000 | 150,000 | PASS |
| MR02 | Essential expenses | Free / Cash Flow | 45,000 | 45,000 | PASS |
| MR03 | Monthly surplus | Free / Cash Flow | 97,000 | 97,000 | PASS |
| MR04 | Net worth (incl. retirement) | Free / Net Worth | 6,600,000 | 6,600,000 | PASS |
| MR05 | Total assets | Free / Net Worth | 7,800,000 | 7,800,000 | PASS |
| MR06 | Goal progress % | Premium / Goals | 73.472482 | 73.47248161940081 | PASS |
| MR07 | Retirement opening balance | Premium / Retirement | 2,500,000 | 2,500,000 | PASS |
| MR08 | Total portfolio value | II / R4 Performance | 1,053,893.74 | 1,053,893.75 | PASS |
| MR09 | SIP total invested | II / R5 SIP | 30,000 | 30,000 | PASS |
| MR10 | X-Ray top-scheme concentration | II / R5 X-Ray | 0.7590898077 | 0.7590898038820327 | PASS |
| MR11 | Realized capital gain | II / R6 Tax | 50,000 | 50,000 | PASS |
| MR12 | Review items ranked by severity | II / R9 Review Centre | high first | high first | PASS |

**12/12 PASS.** Two genuine cross-engine consistency findings surfaced
along the way (not part of the original 12, found incidentally while
deriving MR08/MR10): `investment_performance`'s `totalValue` and
`portfolio_xray`'s `totalPortfolioValue` agree on the portfolio's total
value to the cent, both independently matching a from-scratch hand
computation of the seeded NAV/units data — proving no double counting
between the R4 and R5 engines when both draw from the same underlying
holdings snapshots. X-Ray's `schemeConcentration.top1` (0.7590898038820327)
matches the largest fund's value share of that same total exactly.

DEV cleanup: the reconciliation test user was deleted after the run;
independently re-verified 0 leftover.

Full detail and defects found while building this: see
`R10_ACCEPTANCE_REPORT.md`'s "Gate 3" section, and `R10_TESTING_AND_VERIFICATION.md`.
