# R5 — Acceptance Report

**Release:** Investment Intelligence R5 — SIP Intelligence & Portfolio X-Ray
**Branch:** `feature/investment-intelligence-r5-sip-xray`
**Baseline:** `f1f509a` on `feature/investment-intelligence-r4-performance-benchmark`
(UNCONDITIONAL FULL PASS), confirmed as an ancestor of HEAD.

## Final classification

# UNCONDITIONAL FULL PASS

Upgraded from CONDITIONAL PASS after migration 0044 was applied to DEV by the
Product Owner. **Every previously-blocked check has been executed and passes.
Nothing remains BLOCKED, and no state remains unverified.**

---

## 1. What is proven

| Area | Evidence |
| --- | --- |
| Baseline reproduced | 669/669 tests, tsc clean, R4 50-case cert, R4 forgery fix — all re-run by this session, not inherited |
| Calculation correctness | **89/89 cases, 698/698 comparisons, 0 failures** against an oracle that imports no production code and uses a different XIRR algorithm; max variance 5.749e-08 vs a 1e-6 tolerance |
| Certification can genuinely fail | **Three** negative controls executed green → red → green, with the broken code never committed |
| Manual reconciliation | **12/12** hand-worked cases pass; largest variance 3.098e-09 |
| Mathematical identities | Exact 14% look-through; 3.2%+2.0%=5.2%; overlap symmetry and 0..1 bounds; HHI convention; weight identity summing to exactly 1 |
| No fabrication | 14 distinct "unavailable is never zero" proofs across SIP, X-Ray and debt |
| SIP live-DEV | **26/26 PASS** end-to-end through the real API, independently computed expected values |
| X-Ray live-DEV | **32/32 PASS** end-to-end through the real API, independently computed expected values |
| Security — full pack | **24/24 PASS, 0 BLOCKED** |
| Security — R4 regression | **10/10 PASS**; R4's analytics-forgery hole confirmed still closed, via service-role ground truth |
| Browser truthfulness | **All 12 states rendered and read**; 0%-coverage control re-run against a real empty table with 0 charts / 0 SVGs / 0 tables / 0 "0.00%"; 0 advisory phrases; 0 mentions of "alpha" |
| No net-worth impact | Proven live: `investments=0 assets=0` after a full multi-fund look-through |
| Determinism | Identical input fingerprint across repeat live runs; `cases.json` byte-stable |
| Static | tsc clean; lint **identical to baseline** (zero new errors/warnings); 800/800 tests; build exit 0 |

## 2. The condition — now closed

Migration 0044 was applied by the Product Owner and verified live by this
session (`scripts/ii_r5_schema_probe.mjs` → "MIGRATION 0044 FULLY APPLIED: YES",
all six tables with every expected column present).

| Previously | Now |
| --- | --- |
| SEC-R5-001 … 011 **BLOCKED** | **11/11 PASS** — all five new reference/analytics tables reject ordinary-user writes with HTTP 403 `42501`; cross-user read/delete/tamper all blocked |
| LIVE-R5-005 … 009 **BLOCKED** | **PASS** — overlap, multi-fund look-through, partial coverage, stale holdings and debt all exercised against real seeded DEV data |
| Six browser states **not seen** | **All rendered and read**, every figure independently re-derived |

Full pack: `node scripts/ii_r5_live_dev_security_tests.mjs` → **24 PASS /
0 FAIL / 0 BLOCKED**.

### Two things worth recording from the closure pass

**1. HTTP 204 does not mean "succeeded".** The cross-user DELETE (SEC-R5-005)
and the owner's UPDATE (SEC-R5-006) both returned **204**. They are recorded
PASS only because service-role ground truth confirmed the row survived
unchanged — RLS filtered the statement to zero rows rather than rejecting it.
A pack that trusted status codes would have mis-reported both.

**2. The placeholder verdicts were removed.** The security pack previously
emitted `LIVE-R5-001 … 010` as BLOCKED with "Scenario harness not executed in
this run" even when it could have run them. It now **reads each scenario
harness's own results file and reports what that harness actually recorded**,
reporting BLOCKED only when a harness genuinely has not been run. A placeholder
that can silently become a PASS is a certification hazard.

## 3. Defects found and fixed during R5

### 3.1 PostgREST silent truncation (found by live testing)

Unbounded selects cap at 1000 rows, reporting truncation only in
`Content-Range`. Reproduced: 1500 seeded NAV rows returned exactly 1000
(`0-999/1500`). Caused spurious "NAV unavailable", wrong as-of caps, and failed
simulations on funds with complete data. Fixed with an explicit paging helper.
Invisible to unit tests, review, and the 89-case pack — only live testing found it.

### 3.2 Pause threshold mis-classifying healthy SIPs (found by testing)

`LATE_MAX_MISSED` was 1.0 nominal periods. Because month lengths vary 28–31
days against a 30.4375-day period, a monthly SIP viewed on the very day its next
instalment fell due measured 1.018 periods overdue and was labelled
`POSSIBLE_PAUSE` — flagging a SIP that had missed nothing. Raised to 1.5.
`LIKELY_STOPPED` still requires > 3 periods and remains unreachable from one
missed payment.

## 4. Finding against the certified R4 baseline

`lib/services/investment-intelligence/analyticsRepository.ts` has the **same**
four unbounded reads that caused 3.1 (`ii_transactions`,
`ii_holding_snapshots`, `ii_prices_nav`, `ii_benchmark_series`), with no
`.range()` and no `.limit()`. R4 is very likely affected on any household with
> 1000 rows in any of those tables — which is realistic for a few years of daily
NAV.

**Deliberately not fixed here.** It is certified R4 code; changing it would
alter certified behaviour without re-certification.

**Status:** independently confirmed by the coordinating session (zero `.range()`
calls across 8 large-table reads in that file) and now being fixed under a
separate task. R5 has not touched `analyticsRepository.ts` and will not, to
avoid conflicting with that work.

## 5. Known limitations, stated plainly

None of these blocks the classification; all are bounded, disclosed, and
visible to the user where relevant.

1. **Fund-manager concentration deliberately DEFERRED** — no reliable versioned
   metadata source exists. Disclosed in the UI rather than estimated.
2. **Multi-agency credit-rating consolidation suppressed** — no approved
   methodology is configured, so agency-specific data is retained and the
   consolidated view withheld.
3. **Industry exposure** is implemented but produces results only where genuine
   industry classification exists; it is never derived from sector data.
4. Formal performance matrix (1/10/25/50/100 funds × 50/100/250 holdings) **not**
   executed. No N+1 or quadratic-in-holdings pattern found by inspection; the
   live 5-fund / 21-security portfolio and the 10-fund overlap matrix both
   responded without perceptible delay.
5. The `ii_fund_holdings` R1 table remains in place, unused by R5, which reads
   the new versioned tables instead.
6. **R5 ships the holdings architecture and data contract, but no production
   holdings feed.** All look-through evidence to date uses controlled seeded
   data. A real disclosure source is an R6 prerequisite.
7. Security testing covers the RLS and API surface. No session-fixation, CSRF,
   or JWT-forgery testing was performed.

## 6. Critical-FAIL conditions — none present

All 25 spec critical-FAIL conditions were checked. None are present. The most
load-bearing:

| Condition | Status |
| --- | --- |
| Incorrect SIP XIRR | Not present — 4.8e-14 live variance |
| Benchmark SIP not using identical cash flows | Not present — 36/36 dates and amounts verified live |
| SIP XIRR compared to benchmark CAGR | Not present — structurally refused (`CASHFLOWS_NOT_IDENTICAL`) |
| Ambiguous purchases labelled confirmed | Not present |
| Fabricated SIP value where units unattributable | Not present — suppressed with reason |
| Benchmark missing but result still shown | Not present |
| Underlying holdings double-counting wealth | Not present — weight identity = 1 exactly |
| Incorrect weighted look-through | Not present — exactly 14% |
| Incorrect overlap formula | Not present — exactly 5%, symmetric |
| Securities matched by ambiguous names | Not present — no fuzzy matching exists |
| Incomplete holdings shown as 100% | Not present — 87% stays 87% |
| Stale holdings presented as current | Not present |
| Future snapshot used for an earlier date | Not present |
| 0% coverage rendered as a real all-zero portfolio | Not present — proven in a browser |
| Missing rating treated as a real rating | Not present — `UNRATED` |
| Fabricated duration | Not present — suppressed |
| Users able to modify reference data | Not present — 403 `42501` on all five tables |
| Users able to forge analytics | Not present — 403 `42501` |
| Cross-household leakage | Not present — proven live |
| R5 changing net worth | Not present — no register writes |
| R4 security regression returning | Not present — 10/10 |
| Independent certification disagreeing | Not present — 698/698 |
| Negative control failing to detect | Not present — both went red |
| Personalised recommendation anywhere | Not present — 0 advisory phrases rendered |

## 7. Scope discipline

**No R6 scope was implemented.** R5 contains no tax calculation, no STCG/LTCG,
no capital-gains harvesting, no tax-lot optimisation, no exit loads, no TER or
expense-ratio leakage, no direct-vs-regular cost comparison, and no
switch/buy/sell recommendation. The FIFO attribution convention is explicitly
scoped as the only disposal convention R5 accepts and explicitly defers tax-lot
optimisation to R6.

`R5_ARCHITECTURE_EXCEPTION.md`: **NONE**.

## 8. Prerequisites for R6

1. **A real fund-holdings data source.** R5 ships the provider architecture,
   the versioned schema and the data contract, but no production feed. Every
   look-through result to date is over controlled seeded data.
2. Resolve the R4 unbounded-read finding (section 4). Being handled separately;
   `analyticsRepository.ts` was deliberately not touched by R5.
3. Product Owner decision on the migration-numbering fork (disclosed, untouched).
4. Product Owner decision on an approved multi-agency credit-rating
   consolidation methodology, if consolidated credit quality is wanted.
5. Optionally, a reliable versioned fund-manager metadata source, which would
   let the deferred fund-manager concentration analysis be built.
