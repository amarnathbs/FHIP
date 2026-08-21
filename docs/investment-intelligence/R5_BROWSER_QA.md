# R5 — Browser QA

Conducted in a **real browser against the running application**, logged in as a
real authenticated user with real seeded DEV data. Every claim below is a
**rendered** observation — read out of the live DOM — not an inference from
React source. Where a claim is about the *absence* of something, it is backed
by an element count taken from the live page, not by eyeballing a screenshot.

Fixture: `scripts/ii_r5_browser_qa_fixture.mjs` (seeded, exercised, torn down).

Seeded scenarios, chosen to force the states R5 must render honestly:

1. **Benchmarked Growth Fund** — 41 monthly ₹5,000 SIPs, mapped TRI benchmark
2. **Unbenchmarked Fund** — 36 monthly ₹3,000 SIPs, **no benchmark mapping**
3. **Paused SIP Fund** — 30 scheduled SIPs with a deliberate 4-month gap
4. All three lack fund-holdings disclosure → **0% X-Ray coverage**

---

## 1. SIP Intelligence — data available

Rendered and read:

```
Analysis as at 2024-06-28
3 recurring series identified
The analysis date has been set to 2024-06-28, the most recent date for which
real data exists, rather than 2026-08-21.
```

| Check | Rendered | Result |
| --- | --- | --- |
| As-of date displayed, not silently "today" | "Analysis as at 2024-06-28" plus an explicit note that it was capped from 2026-08-21 | PASS |
| Confidence badge | "Confirmed by statement" | PASS |
| Cadence and history | "monthly · 41 contributions · 2021-01-05 to 2024-05-05" | PASS |
| Currency correct for an Indian investment | "₹2,05,000" — Indian lakh digit grouping, INR symbol, never converted to AUD | PASS |
| Actual return | "RETURN ON THESE CONTRIBUTIONS 13.99%" | PASS |
| Benchmark return, same schedule | "SAME CONTRIBUTIONS IN R5_QA_NIFTY_… 8.99%" | PASS |
| Excess-return label | "**SIP BENCHMARK EXCESS RETURN** 5.00%" | PASS |
| Label is never "alpha" | 0 occurrences of "alpha" in the whole page | PASS |

The excess-return explanation renders verbatim:

> "Your money-weighted return minus what the same contributions, on the same
> dates, would have returned in the benchmark. Both sides use an identical
> contribution schedule, so the two figures are directly comparable."

## 2. SIP Intelligence — benchmark unavailable (the critical state)

For the fund with **no benchmark mapping**, the rendered output is:

```
SAME CONTRIBUTIONS IN THE BENCHMARK
Not available
No benchmark is mapped to this scheme, or no benchmark history is available,
so a like-for-like benchmark comparison cannot be produced. No comparison
figure is shown.

SIP BENCHMARK EXCESS RETURN
Not available
```

| Check | Result |
| --- | --- |
| Renders "Not available", **not 0.00%** | PASS |
| Carries the engine's own reason | PASS |
| Excess return also unavailable, not actual-minus-zero | PASS |
| The fund's **actual** return still renders (8.99%) | PASS |

The last row matters: one missing input suppresses only the metric that depends
on it, not the whole card.

## 3. SIP Intelligence — gap and pause states

| Fund | Rendered badge | Rendered statement |
| --- | --- | --- |
| Paused SIP Fund | "No recent recorded activity" | last contribution 2023-08-02, ~11 intervals before as-of |
| Benchmarked Growth Fund | "Gap in recorded contributions" | "…a gap of about 1 expected interval(s) as at 2024-06-28. The records available do not indicate whether the mandate was paused or whether later data has simply not been imported." |

The wording is observational throughout and explicitly acknowledges the
alternative explanation (data simply not imported) rather than asserting the
user stopped their SIP.

## 4. SIP detail view

Expanded in the browser. Rendered content:

* **2 charts** (contribution history bar chart with real dates 2021-01-05 →
  2024-05-05 and a ₹0–₹6,000 axis; value comparison with a ₹0–₹280,000 axis)
* **Consistency:** "Recorded 41 of 41 · Consistency 100% · Average ₹5,000 ·
  Smallest ₹5,000 · Largest ₹5,000" — correct for a flat SIP
* **Calculation assumptions**, rendered in full:
  * "Contributions are treated as money out; redemptions, distributions
    received, and the closing value as money in."
  * "The closing value uses the NAV published on 2024-06-28 (159.525721)."
  * "The benchmark comparison applies each contribution's exact amount, on its
    own date, to R5_QA_NIFTY_… (TRI). A contribution falling on a non-trading
    day uses the next available observation."
  * "These figures describe what has already happened. They are not a forecast
    and not a recommendation."
* **Historical timing comparison:** Contributed progressively ₹2,62,167 · Same
  total invested at the start ₹3,23,409 · Difference −₹61,241, with the
  "not a forecast and not a recommendation" framing
* **5 observations**, every one tagged `OBSERVATION`

The NAV date *and* value are shown, so the closing value is traceable.

## 5. Simulation

| Check | Rendered | Result |
| --- | --- | --- |
| Disclaimer shown **before** any number | "**Simulation.** These are simulations over historical prices… They are not forecasts, and they are not a recommendation about which schedule to choose." | PASS |
| Three variants side by side | Flat ₹2,10,000 → ₹2,67,209 · 5% step-up ₹2,23,884 → ₹2,83,065 · 10% step-up ₹2,38,530 → ₹2,99,741 | PASS |
| No variant recommended | 0 occurrences of "recommended" / "best" / "optimal" | PASS |
| Assumptions disclosed | Contribution day rule, step-up anniversary, non-trading date, rounding, period, distributions-included flag, methodology version | PASS |

## 6. Portfolio X-Ray — the mandatory 0%-coverage negative control

This is the direct application of R4's own benchmark-coverage lesson to R5's
UI, and the single most important browser check in this release.

A controlled fixture with **0% holdings coverage** was rendered. Read from the
live DOM:

```
Positions as at 2024-06-28
Fund holdings as at not available
No holdings data
Coverage 0.0%

No fund holdings disclosure is available for any scheme in this portfolio at
the selected date. Look-through exposure cannot be calculated, so no exposure
breakdown is shown.
```

Programmatic element counts taken from the live page:

| Measurement | Value | Meaning |
| --- | --- | --- |
| `.recharts-wrapper` / `.recharts-surface` | **0** | no charts rendered at all |
| `<svg>` elements | **0** | nothing drawn |
| `<table>` elements | **0** | no top-holdings table |
| `[data-testid="xray-unavailable"]` | **2** | explicit unavailable states |
| occurrences of `"0.00%"` | **0** | no fabricated zero values |
| banned advice phrases | **0** | none |
| coverage element | "Coverage 0.0%" | coverage stated honestly |

**Result: PASS.** 0% coverage renders as an explicit unavailable state with a
real reason. It does **not** render an all-zero sector chart, an empty
top-holdings table, or a 0.00% concentration figure.

Both as-of dates are shown **separately** — "Positions as at 2024-06-28" and
"Fund holdings as at not available" — confirming the distinction stays visible
even when one side is missing.

The freshness badge reads "No holdings data", not "Current".

## 7. Portfolio X-Ray — overlap tab

Clicked in the browser. Rendered:

```
Fund overlap is not available
Fund overlap needs published holdings for at least two schemes in this
portfolio. Fewer than two are available, so no overlap figures are shown.
```

| Measurement | Value |
| --- | --- |
| `[data-testid="overlap-heatmap"]` | **0** |
| `<table>` elements | **0** |

No fabricated heatmap of zeros. PASS.

## 8. Deferred analysis disclosed honestly

Rendered verbatim on the X-Ray page:

> "Fund-manager concentration is not shown. No reliable, versioned fund-manager
> metadata source is available to this platform, and inferring a manager from
> scheme names would not be dependable. This analysis is deferred rather than
> estimated."

And for AMC concentration, where scheme metadata genuinely lacks the fund house:

> "Scheme metadata does not identify the fund house for any position, so AMC
> concentration is not shown."

## 9. Language sweep

Full-page scan of the rendered SIP page for advisory language:

```
bannedFound:        []          (16 phrases checked)
alphaMentions:      0
excessLabelPresent: true
adviceSentences:    [" they are not advice, and they are not a forecast."]
```

Phrases checked and **not found**: "you should", "we recommend",
"recommended", "consider switching", "switch to", "sell ", "buy more",
"increase your sip", "stop this sip", "stop your sip", "reduce your",
"best fund", "optimal", "you must", "advise".

The only sentence containing "advice" negates it.

The same sweep on the X-Ray page found 0 banned phrases.

---

## 10. X-Ray states — second pass, after migration 0044 was applied

The six states blocked in the first pass have now all been rendered and read.
Fixture: `scripts/ii_r5_browser_qa_xray_fixture.mjs` (seeded, exercised, purged).

Portfolio: **₹2,500,000 across five funds** — Bluechip Equity ₹1,000,000 (40%),
Flexi Cap ₹600,000 (24%), Corporate Bond ₹400,000 (16%), Legacy Midcap
₹300,000 (12%, disclosed 2023-09-30), Unlisted Opportunities ₹200,000 (8%, **no
disclosure at all**).

### 10.1 Normal portfolio with real holdings

Rendered header:

```
Positions as at 2024-06-30
Fund holdings as at 2024-06-01 (oldest 2023-09-30)
Much older data
Coverage 89.8%
```

Rendered top-holdings table (10 rows), independently re-derived by hand:

| Security | Rendered | Independent calculation | Match |
| --- | --- | --- | --- |
| Nestle India | **35.44%** (₹8,86,000, 3 schemes) | .40×40.0 + .24×60.0 + .12×42.0 = 35.44 | ✓ |
| Reliance Industries | **5.72%** (₹1,43,000, 2 schemes) | .40×9.5 + .24×8.0 = 5.72 | ✓ |
| GOI 7.26% 2033 | **5.12%** (1 scheme) | .16×32.0 = 5.12 | ✓ |
| HDFC Bank | **5.08%** (2 schemes) | .40×8.2 + .24×7.5 = 5.08 | ✓ |
| Infosys | **4.28%** (2 schemes) | .40×7.1 + .24×6.0 = 4.28 | ✓ |
| Cummins India | **2.64%** (2 schemes) | .12×12.0 + .24×5.0 = 2.64 | ✓ |

Rendered coverage statement, re-derived:

* scheme coverage **92.0%** = ₹2,300,000 / ₹2,500,000 ✓
* within-scheme disclosure **97.7%** = (.40×97 + .24×100 + .16×100 + .12×92)/.92 ✓
* effective coverage **89.8%** = 0.920 × 0.977 ✓

Concentration: largest **35.44%**, top-5 **55.64%** (35.44+5.72+5.12+5.08+4.28 ✓),
top-10 69.76%, 21 securities.

Market cap: LARGE **62.0%**, MID **9.6%**, not classified **15.2%** — the last
being the debt book (.16 × 95% non-cash), which legitimately carries no
market-cap class.

Element counts from the live DOM: **1 chart, 1 SVG, 1 table with 10 rows,
1 unavailable block** (AMC concentration), **0 advisory phrases**.

### 10.2 Partial coverage

Rendered in the "What is not in the breakdown above" panel, each re-derived:

| Bucket | Rendered | Independent |
| --- | --- | --- |
| Cash | 2.2% | .40×3.6 + .16×5.0 = 2.24 ✓ |
| Derivatives | 0.0% | none seeded ✓ |
| Other | 0.0% | none seeded ✓ |
| Unidentified holdings | 0.8% | .24×3.5 = 0.84 ✓ |
| Schemes with no disclosure | 8.0% | ₹200,000/₹2,500,000 ✓ |
| Not disclosed | 2.2% | .40×3.0 + .12×8.0 = 2.16 ✓ |

Securities + these six buckets = **1.0000** exactly. Nothing was rescaled.

### 10.3 Stale holdings and mixed dates

> "Contributing disclosures span **245 days**, so this view mixes more than one
> portfolio date. At least one scheme's holdings disclosure is older than the
> freshness threshold, so this describes an older composition. Coverage is too
> low, or disclosure dates too far apart, for a portfolio-level conclusion; the
> figures below describe only the covered portion."

Freshness badge reads **"Much older data"** (VERY_STALE — oldest disclosure
2023-09-30 is 274 days before the 2024-06-30 as-of, past the 210-day ceiling).
245-day spread exceeds the 185-day suppression threshold, so the portfolio-level
conclusion is correctly withheld. **PASS.**

### 10.4 Populated overlap heatmap

Rendered 5×5 matrix:

| | Legacy | Corp Bond | Unlisted | Bluechip | Flexi |
|---|---|---|---|---|---|
| **Legacy** | 100% | 0% | — | 40% | 57% |
| **Corp Bond** | 0% | 100% | — | 0% | 0% |
| **Unlisted** | — | — | — | — | — |
| **Bluechip** | 40% | 0% | — | 100% | 62% |
| **Flexi** | 57% | 0% | — | 62% | 100% |

Independently re-derived:

* **Bluechip ↔ Flexi**: min(9.5,8.0) + min(8.2,7.5) + min(7.1,6.0) + min(40,60)
  = 8.0 + 7.5 + 6.0 + 40.0 = **61.5%** ✓ (displayed 62% rounded; the pair-detail
  panel shows 61.5% and itemises all four contributions exactly)
* **Legacy ↔ Flexi**: 42 + 5.5 + 5 + 4.5 = **57.0%** ✓
* **Bluechip ↔ Legacy**: Nestle only, min(40,42) = **40%** ✓
* **Corporate Bond ↔ everything**: **0%** ✓ (no securities in common)

Matrix is **symmetric**, **bounded 0..1**, **diagonal 100%**.

**The undisclosed fund renders "—", not "0%"** — unavailable is not zero, even
in a heatmap cell where a zero would look perfectly plausible.

Quality warnings rendered on the affected pairs, verbatim:

> "0.0% and 3.5% of these funds could not be matched to identified securities
> and are excluded from the overlap figure."
> "At least one of these funds has holdings data older than the freshness
> threshold…"

0 advisory phrases; no overlap level is labelled good or bad.

### 10.5 Debt X-Ray widgets

| Metric | Rendered | Independent |
| --- | --- | --- |
| SOVEREIGN | 5.12% | .16×32.0 ✓ |
| AAA | 6.40% | .16×(22+18) ✓ |
| AA | 3.68% | .16×(14+9) ✓ |
| 1–3 years | 5.76% | .16×(22+14) ✓ |
| 3–5 years | 2.88% | .16×18 ✓ |
| 5–10 years | 6.56% | .16×(32+9) ✓ |
| Modified duration | **4.05 years** | (32×6.4+22×2.3+18×3.7+14×1.8+9×4.2)/95 = 4.0526 ✓ |

### 10.6 Missing classification, holdings present

Separate fixture user, all holdings unclassified:

```
Sector exposure
Sector exposure is not available
No classification data is available for the underlying holdings, so this
breakdown is not shown.

Market-cap exposure
Market-cap exposure is not available
```

Element counts: **0 charts, 0 SVGs** — no fabricated zero-bucket sector chart.
The top-holdings table still renders **3 rows** and concentration still reads
largest 45.00% / top-5 100.00% / 3 securities, proving look-through itself is
unaffected by missing classification. Coverage 100.0%, freshness "Current".

### 10.7 The 0%-coverage negative control, re-run against a real table

The first pass exercised this while `ii_fund_holdings_snapshots` did not exist,
so the unavailable state was partly an error path. It was **re-run after 0044
was applied**, against a user with real positions and a real but empty holdings
table — the genuine production condition.

| Measurement | Value |
| --- | --- |
| `.recharts-wrapper` | **0** |
| `<svg>` | **0** |
| `<table>` | **0** |
| top-holdings rows | **0** |
| exact `0.00%` occurrences | **0** |
| concentration block rendered | **false** |
| sector block rendered | **false** |
| unavailable blocks | **2** |
| advisory phrases | **0** |
| coverage | "Coverage 0.0%" |
| as-of | "Positions as at 2024-06-30 / Fund holdings as at not available" |

**PASS.** Still no fabricated analytics.

### 10.8 A note on "0.0%" values that ARE legitimate

The missing-classification page renders six `0.0%` figures in the honest
remainder panel (Cash, Derivatives, Other, Unidentified, Schemes with no
disclosure, Not disclosed). These were checked individually against the DOM and
are **correct real zeros**: that fixture's single fund discloses exactly 100% in
identified securities with no cash, no derivatives and no unresolved lines.

The distinction R5 must hold is between *a real measured zero* and *an
uncomputable value rendered as zero*. On the same page the uncomputable
analytics (sector, market cap) correctly render "not available" with zero
charts. Both behaviours are present and correct simultaneously.

## 11. Browser QA — final status

All twelve states are verified rendered: SIP with data, SIP benchmark
unavailable, SIP gap/pause, SIP detail, SIP simulation, X-Ray normal, X-Ray
partial coverage, X-Ray stale/mixed dates, overlap heatmap, debt widgets,
missing classification, and 0% coverage. **No state remains unverified.**
