# R5 — SIP Intelligence Methodology

Every formula, threshold and failure condition used by R5's recurring-investment
analytics. Nothing important about this methodology exists only in code.

Governing versions (all embedded in every persisted result):

| Component | Version constant |
| --- | --- |
| Engine | `sip-engine-r5-v1` |
| Detection | `sip-detection-r5-v1` |
| Attribution | `sip-attribution-fifo-r5-v1` |
| SIP XIRR | `sip-xirr-r5-v1` |
| Benchmark SIP | `benchmark-sip-identical-cashflow-r5-v1` |
| Consistency / activity | `sip-consistency-r5-v1` |
| Simulation | `sip-simulation-historical-r5-v1` |
| Timing comparison | `sip-timing-historical-comparison-r5-v1` |
| Date alignment | `next-available-on-or-after-v1` |
| XIRR solver (reused from R4) | `xirr-newton-bisection-v1` |
| Thresholds | `sip-thresholds-r5-v1` |

---

## 1. Relationship to certified R2 data

R5 is an **analytical interpretation layer**. It reads `ii_transactions` and
never writes to it. No certified R2 `transaction_type` is ever rewritten or
reclassified. R2 remains transaction truth; R5 only groups and annotates.

Transactions with `status = 'reversed'` are excluded from the analytical view.
Nothing is deleted or amended to achieve that.

## 2. Series identity

A recurring-contribution series is identified by

```
Owner + Account/Folio + Instrument + Recurring-Contribution-Series
```

realised as the deterministic key `${accountId}:${instrumentId}:${discriminator}`.

Two genuinely different mandates in the **same fund and folio** are **never
auto-merged**. A ₹5,000 monthly SIP and a ₹10,000 quarterly SIP in one scheme
are two series, because they are two mandates.

Separation is performed by `partitionIntoMandates()`:

1. Source-confirmed SIP instalments are separated from ordinary purchases
   first. This matters for section 5: a lump-sum purchase must never be
   absorbed into a SIP series.
2. Within the confirmed set, instalments are clustered by amount — amounts
   within ±5% of a cluster's median join it, anything else starts a new cluster.
3. Adjacent clusters are re-merged **only** when their union yields one clean
   periodic cadence *and* a monotonic amount trajectory. That is a step-up
   SIP, not two mandates. Anything else stays split.

## 3. Cadence classification

Consecutive contribution intervals (in days) are scored against versioned bands:

| Cadence | Interval band (days) | Nominal period | Periods/yr |
| --- | --- | --- | --- |
| WEEKLY | 5–9 | 7 | 52 |
| FORTNIGHTLY | 12–17 | 14 | 26 |
| MONTHLY | 24–38 | 30.4375 | 12 |
| QUARTERLY | 80–105 | 91.3125 | 4 |
| ANNUAL | 350–380 | 365.25 | 1 |

The band capturing the most intervals wins, provided it captures at least
**70%** of them (`MIN_INTERVAL_CONSISTENCY_FOR_CADENCE`). Otherwise:

* coefficient of variation of intervals ≤ 0.35 → `OTHER_RECURRING`
* otherwise → `IRREGULAR`

A series is **never forced to monthly**. Cadence is driven by observed evidence.

## 4. Detection confidence

| Value | Reached when |
| --- | --- |
| `CONFIRMED_SOURCE` | The source itself asserts it: R2 `transaction_type = 'sip'`, or the source description matches `\bSIP\b` / `SYSTEMATIC\s+INVESTMENT`. |
| `HIGH_CONFIDENCE` | Inferred: ≥ 3 contributions, a consistent cadence band, and either stable amounts (±5% of median) or a monotonic step-up/step-down. |
| `POSSIBLE` | Consistent cadence but amounts that do not match a single mandate. |
| `AMBIGUOUS` | ≥ 2 but < 3 contributions, or ≥ 3 contributions with no stable interval. |
| `NOT_SIP` | A single purchase. |

**The rule that matters:** an inferred series can *never* be labelled
`CONFIRMED_SOURCE`. Only genuine source evidence produces that value.
Certification cases SIP-003, SIP-017, DQ-R5-008 and DQ-R5-009 assert this, and
the browser QA confirms the badge reads "Identified by pattern" rather than
"Confirmed by statement" for inferred series.

`MIN_CONTRIBUTIONS_FOR_INFERENCE = 3` is deliberately conservative: **two
purchases a month apart are a coincidence, not a SIP.**

Only `CONFIRMED_SOURCE`, `HIGH_CONFIDENCE` and `POSSIBLE` series are presented
as recurring investments. `AMBIGUOUS` and `NOT_SIP` groupings are reported
separately, by count and rationale, and are never dressed up as SIPs.

## 5. Unit attribution (`sip-attribution-fifo-r5-v1`)

**The critical rule.** If a fund contains both SIP instalments and independent
lump-sum purchases, the fund's whole current value must **not** be attributed
to the SIP series.

R5 reconstructs the series' own surviving units under **FIFO across the whole
(account, instrument) position**. FIFO is the only disposal convention R5 will
accept, because it is already the canonical structure R1/R2 model via
`ii_tax_lots.acquisition_date`, and because under it "how many surviving units
came from SIP instalments?" has exactly one answer. R5 does **not** implement
tax-lot optimisation — that is R6 scope and an explicit hard stop.

Same-date ordering is deterministic: acquisitions settle before disposals, then
by transaction id.

Attribution reports `unavailable` — and the SIP-specific XIRR is **suppressed**,
not approximated — when:

| Reason | Meaning |
| --- | --- |
| `MISSING_UNITS_ON_CONTRIBUTION` | A series contribution has no unit figure. |
| `MISSING_UNITS_ON_NON_SERIES_ACQUISITION` | Another purchase in the same fund has no unit figure. |
| `MISSING_UNITS_ON_DISPOSAL` | A redemption/switch-out has no unit figure. |
| `NO_SERIES_UNITS` | No series units are still held at the as-of date. |
| `DISPOSALS_EXCEED_ACQUISITIONS` | Recorded disposals exceed acquisitions. |

When attribution is unavailable, the caller is directed to R4's certified
**fund-level** investor XIRR. A SIP-specific figure is never fabricated.

Live proof (LIVE-R5-003): a fund holding 24 × ₹3,000 SIP instalments plus a
₹250,000 lump sum reported an ending value of **₹84,428.09** — the series units
only — against a whole-fund value of ₹393,688.53.

## 6. Cash-flow sign convention

Reused unchanged from the certified R4 XIRR engine:

* contribution → **negative**
* redemption / cash distribution received → **positive**
* ending value at the as-of date → **positive terminal flow**

R5 contains **no second XIRR implementation**. It calls `lib/engines/investment-intelligence/xirr.ts`.

## 7. Actual SIP XIRR

```
Σ CF_i / (1 + r)^((date_i − date_0)/365) = 0
```

with

```
TerminalValue = attributedSeriesUnits × NAV(asOfDate)
```

`NAV(asOfDate)` is resolved by the **valuation** alignment rule (section 9).

Unavailable reasons: `ATTRIBUTION_UNAVAILABLE`, `NAV_UNAVAILABLE`,
`NO_CONTRIBUTIONS`, `XIRR_UNAVAILABLE`.

## 8. Benchmark-equivalent SIP — the heart of R5

For every eligible series, a **synthetic benchmark investment receives the
identical cash-flow schedule**: each actual contribution's exact amount, on its
own date, applied to the mapped benchmark.

```
units_i          = Contribution_i / BenchmarkLevel(date_i)
SyntheticUnits   = Σ units_i
TerminalValue    = SyntheticUnits × BenchmarkLevel(asOfDate)
BenchmarkSipXIRR = XIRR(same dates, same amounts, TerminalValue)
```

### The prohibited comparison

It is **forbidden** to compare Actual SIP XIRR against an ordinary benchmark
5Y CAGR and call the difference "SIP alpha". Those numbers describe
incompatible cash-flow structures: a CAGR describes one lump sum exposed for
the whole period, while a SIP's capital arrives progressively, so most of it
was never exposed to the full period.

The only comparison R5 produces is

```
SIP benchmark excess return = Actual SIP XIRR − Benchmark SIP XIRR
```

over exactly matching cash flows and period. It is **never** called alpha —
R4's `alpha` is a regression intercept and means something different.

`calculateSipExcessReturn()` additionally refuses to subtract unless every
applied benchmark contribution matches the real contribution's date and amount
(`CASHFLOWS_NOT_IDENTICAL`). Live proof LIVE-R5-004b confirmed 36/36 matching
contributions.

### Coverage discipline

| Reason | When |
| --- | --- |
| `MISSING_BENCHMARK` | No mapping, or no history at all. |
| `INCOMPLETE_BENCHMARK_HISTORY` | **Any** contribution date cannot be aligned. |
| `BENCHMARK_TERMINAL_UNAVAILABLE` | No observation on/before the as-of date. |

A partial-period comparison is **never** silently presented as full-period.
One unalignable contribution suppresses the whole comparison. The partial work
is retained in `unalignedContributions` for transparency but never shown as a
result.

## 9. Date alignment — one rule, used everywhere

`lib/engines/investment-intelligence/sip/dateAlignment.ts` is the **only**
module permitted to map a date onto an observation series. Nothing in R5
indexes a series directly.

* **Contribution dates** → first observation **on or after** the date, within
  10 calendar days. A contribution instructed on a non-trading day is executed
  at the next available trading day's price; searching forward is the
  economically correct direction for an execution price.
* **Valuation dates** → last observation **on or before** the date, within
  10 calendar days. You cannot value a portfolio at an unpublished price;
  searching backward is the only direction that avoids look-ahead bias.

The two directions differ deliberately because they answer different questions.
If no observation exists in the window the result is **unavailable** — never
the nearest-at-any-distance, and never interpolated.

## 10. Consistency statistics (descriptive only)

```
expectedPeriods = round(spanDays / nominalPeriodDays) + 1
skippedPeriods  = max(0, expectedPeriods − observedPeriods)
consistencyPct  = min(1, observedPeriods / expectedPeriods)
```

Plus contribution count, average, median, min, max, total, first/latest date,
and explicit gaps (any interval ≥ 1.5 nominal periods).

These are **records of what happened**. R5 never advises about a skipped
period and never judges the investor. When cadence is non-periodic the
period-based statistics are reported unavailable rather than invented.

## 11. Paused / stopped classification

Expressed in **missed periods relative to the series' own cadence**, so a
quarterly SIP is never judged by a monthly yardstick.

| Status | Periods since latest contribution |
| --- | --- |
| `EXPECTED` | ≤ 0.5 |
| `LATE` | ≤ 1.5 |
| `POSSIBLE_PAUSE` | ≤ 3.0 |
| `LIKELY_STOPPED` | > 3.0 |
| `UNKNOWN` | non-periodic cadence |

**`LIKELY_STOPPED` can never be reached from one missed instalment.**

`LATE_MAX_MISSED` is 1.5, not 1.0. This was corrected during R5's own testing:
month lengths vary 28–31 days against a 30.4375-day nominal period, so a
perfectly healthy monthly SIP viewed on the very day its next instalment fell
due already measured 1.018 periods overdue and was being labelled
`POSSIBLE_PAUSE` — flagging a SIP that had missed nothing. `POSSIBLE_PAUSE`
should mean "about a whole instalment has been missed", which is ~2 periods.

All wording is strictly observational and is asserted advice-free by test.

## 12. Historical simulation

Framed as **SIMULATION**, never a recommendation.

Visible inputs: starting contribution, annual step-up %, historical start/end
dates, and the fund-or-benchmark series used.
Visible outputs: total contributed, terminal value, XIRR — for the illustrative
variants **flat / 5% step-up / 10% step-up**, shown side by side.

R5 never states which variant the user should choose.

Methodology, persisted with the result and displayed in the UI:

* **Contribution date rule** — every *n* months on the start date's
  day-of-month, clamped to the last day of a shorter month. The *original*
  day-of-month is preserved for subsequent steps, so 31 Jan + 1 month = 28 Feb
  but 31 Jan + 2 months = 31 Mar.
* **Step-up anniversary** — the amount increases on each 12-month anniversary
  of the start date, not on a calendar-year boundary. Contribution *k* in
  anniversary year *y* uses `round(start × (1+stepUp)^y)`.
* **Non-trading dates** — the centralised contribution alignment rule.
* **Rounding** — each stepped-up contribution is rounded to the nearest whole
  currency unit (`nearest_whole_unit`).
* **Distributions** — governed by the supplied series. A NAV price series does
  not include them; this is declared explicitly rather than assumed.

## 13. Timing comparison

Compares the actual staggered schedule against a controlled historical
counterfactual: **the same total capital invested in one amount on the series'
own start date, in the same fund, using the same NAV series.**

The reported metric is **wealth difference**, deliberately not an XIRR
difference — the two schedules have fundamentally different cash-flow shapes,
so comparing their XIRRs would be exactly the incompatible comparison R5 exists
to prevent.

It is labelled a **historical timing comparison**. It is never called
"investor skill", and never presented as a recommendation or forecast.

## 14. Insight language rules

Allowed (`OBSERVATION`, `EDUCATION`, `SIMULATION`):

> "36 contributions are recorded against 36 expected intervals between
> 2021-01-05 and 2024-05-05."
> "Over the recorded period this series returned 13.99% on a money-weighted
> basis. The same contributions, on the same dates, applied to NIFTY 50 TRI
> would have returned 8.99%."

Prohibited, and absent from every code path:

> "Increase your SIP." · "Stop this SIP." · "Switch to another fund."
> "You should increase contributions by 10%."

`PERSONALISED_ADVICE` is never produced by R5.

## 15. Failure / unavailable conditions summary

| Condition | Result |
| --- | --- |
| < 3 contributions, no source evidence | `AMBIGUOUS` / `NOT_SIP`, not shown as a SIP |
| No stable interval | `AMBIGUOUS` |
| Units missing anywhere in the position | SIP XIRR suppressed; fund-level R4 XIRR offered |
| NAV unavailable at as-of | Ending value and XIRR suppressed |
| No benchmark mapping/history | `MISSING_BENCHMARK`; no rate, no excess return |
| Any contribution unalignable to benchmark | `INCOMPLETE_BENCHMARK_HISTORY`; whole comparison suppressed |
| Non-periodic cadence | Period statistics unavailable; amount statistics still shown |
| Series NAV history missing | Simulation and timing comparison unavailable |

In every case the result is **unavailable with a reason**. Unavailable is never
rendered as zero.
