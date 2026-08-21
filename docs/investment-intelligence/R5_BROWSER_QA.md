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

## 10. States NOT covered in this browser pass

Stated plainly rather than implied:

* **Normal X-Ray with real holdings** — top-10 effective exposures, sector and
  market-cap charts, concentration figures
* **Partial (non-zero) coverage rendering**
* **Stale-holdings warning rendering**
* **A populated overlap heatmap**
* **Missing-classification rendering with holdings present**
* **Debt X-Ray widgets**

All six require fund-holdings snapshots, which require **migration 0044**, which
this session could not apply (no DDL capability — independently established).
Their engine behaviour is certified by the 89-case pack and their API behaviour
by the route-level contract, but they have **not been seen rendered in a
browser**. This is the principal reason R5 is offered as a CONDITIONAL PASS.
