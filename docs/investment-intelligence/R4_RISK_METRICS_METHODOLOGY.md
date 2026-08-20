# R4 — Risk Metrics Methodology

All formulas live in `lib/engines/investment-intelligence/riskMetrics.ts`
(`risk-metrics-v1`). Sample (n-1) standard deviation is used throughout.
Frequency (`periodsPerYear`) is always caller-supplied and documented at
the call site — the module never mixes daily fund data with monthly
benchmark data; alignment is the caller's responsibility (produced
upstream by whatever assembles the paired periodic-return arrays).

| Metric | Exact formula | Unavailable when |
|---|---|---|
| Volatility | `StdDev(r, n-1) × sqrt(ppy)` | `n < 12` |
| Downside deviation | `sqrt(Σ min(0, r-MAR)² / (n-1)) × sqrt(ppy)`, MAR=0/period by default (explicit, versioned) | `n < 12` |
| Max drawdown | `min_t(value_t/running_peak_t − 1)`, reports peak/trough date+value and first post-trough date `>= peak value` as recovery | `n < 2` valuation points |
| Sharpe | `(annualised return − annualised risk-free) / annualised volatility` | missing risk-free, or volatility = 0 |
| Sortino | `(annualised return − annualised target) / annualised downside deviation` | missing target, or downside deviation = 0 |
| Beta | `Cov(fund,bench,n-1) / Var(bench,n-1)` | `n < 12`, or `Var(bench) = 0` |
| Regression alpha | OLS single-factor: `alpha_period = mean(fund excess) − beta × mean(bench excess)`, then `(1+alpha_period)^ppy − 1` | missing risk-free, or beta unavailable |
| Tracking error | `StdDev(fund_t − bench_t, n-1) × sqrt(ppy)` | `n < 12` |
| Information ratio | `(mean(active) × ppy) / tracking error` — **arithmetic** annualisation, the industry convention for this specific ratio (documented as deliberately different from the geometric/chain-linked "Active Return" headline figure used elsewhere) | tracking error unavailable or = 0 |
| Upside/downside capture | compounded fund return over benchmark-positive (or -negative) periods ÷ compounded benchmark return over the same periods | `< 3` periods in that direction |
| Calmar | `Annualised Return / |Max Drawdown|` | `< 365` days history, or drawdown = 0 |

## Regression alpha is never `fund_return − benchmark_return`

That quantity is active return, a different concept, computed in
`benchmarkEngine.ts`. `regressionAlpha()` performs an actual single-factor
CAPM-style regression against the risk-free rate and beta. Identity B
(`tests/unit/iiR4MathIdentities.test.ts`) proves an index-identical fund
has `alpha ≈ 0` (not merely `active return = 0`, which is trivially true
by construction — the regression alpha calculation is exercised
independently and produces its own near-zero result).

## Minimum-history rules are centralised

`lib/config/investment-intelligence/minimumHistory.ts`
(`min-history-v1`) is the only place any of the `n < 12` / `< 3` / `< 365`
thresholds above are defined. Every risk function imports from there —
none of them hard-code a threshold locally.

## Risk-free rate — never hard-coded

`lib/config/investment-intelligence/riskFreeRate.ts` (`risk-free-rate-lookup-v1`)
is a pure lookup function over a versioned `ii_risk_free_rates` reference
table (migration `0043`; country/period/rate/source/method/version). No
"6%" or any other rate is written directly into `riskMetrics.ts` or any
caller — `sharpeRatio`/`sortinoRatio`/`regressionAlpha` all take the
already-resolved rate as a parameter and are `unavailable`
(`MISSING_RISK_FREE_DATA`) if it is `undefined`.

## Test pack coverage

`tests/unit/iiR4RiskMetrics.test.ts` (RISK-001..020, 26/26 passing) —
including beta ≈ 1 / < 1 / > 1 / negative-beta synthetic series
constructed by scaling a real benchmark series (`0.5×`, `1.5×`, `−1×`) so
the expected beta is known exactly by construction, zero-volatility and
zero-benchmark-variance edge cases, and Calmar's zero-drawdown and
insufficient-history gates. The 50-case pack's TC041-045 riskBundle cases
independently cross-check volatility/beta/tracking-error/Sharpe/max-
drawdown against the from-scratch Python oracle (all 5 pass at `≤1e-6`);
TC049 is the dedicated too-few-observations pathological case (both sides
independently agree `unavailable`).
