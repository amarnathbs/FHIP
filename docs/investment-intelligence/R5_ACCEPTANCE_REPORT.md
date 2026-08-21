# R5 — Acceptance Report

**Release:** Investment Intelligence R5 — SIP Intelligence & Portfolio X-Ray
**Branch:** `feature/investment-intelligence-r5-sip-xray`
**Baseline:** `f1f509a` on `feature/investment-intelligence-r4-performance-benchmark`
(UNCONDITIONAL FULL PASS), confirmed as an ancestor of HEAD.

## Final classification

# CONDITIONAL PASS

Every calculation, security, no-fabrication and no-double-count requirement is
met and independently verified. The condition is a **bounded infrastructure
gap**, not a defect: migration 0044 could not be applied to DEV by this session,
so the Portfolio X-Ray half's live-DEV and browser evidence is incomplete.

This mirrors R4's own first pass, which was CONDITIONAL until a follow-up
closed exactly this class of gap.

---

## 1. What is proven

| Area | Evidence |
| --- | --- |
| Baseline reproduced | 669/669 tests, tsc clean, R4 50-case cert, R4 forgery fix — all re-run by this session, not inherited |
| Calculation correctness | **89/89 cases, 698/698 comparisons, 0 failures** against an oracle that imports no production code and uses a different XIRR algorithm; max variance 5.749e-08 vs a 1e-6 tolerance |
| Certification can genuinely fail | **Both** negative controls executed green → red → green, with the broken code never committed |
| Manual reconciliation | **12/12** hand-worked cases pass; largest variance 3.098e-09 |
| Mathematical identities | Exact 14% look-through; 3.2%+2.0%=5.2%; overlap symmetry and 0..1 bounds; HHI convention; weight identity summing to exactly 1 |
| No fabrication | 14 distinct "unavailable is never zero" proofs across SIP, X-Ray and debt |
| SIP live-DEV | **26/26 PASS** end-to-end through the real API against real DEV data, with independently computed expected values |
| Security — R4 regression | **10/10 PASS**; R4's analytics-forgery hole confirmed still closed, with service-role ground truth |
| Security — API layer | **8/8 PASS** live: unauthenticated blocked, cross-user blocked, spoofed parameters rejected, far-future as-of capped |
| Browser truthfulness | 0%-coverage negative control passes with **0 charts, 0 SVGs, 0 tables, 0 "0.00%"**; benchmark-unavailable renders "Not available"; 0 advisory phrases; 0 mentions of "alpha" |
| No net-worth impact | No write to any financial register anywhere in R5 |
| Static | tsc clean; lint **identical to baseline** (zero new errors/warnings); 800/800 tests; build exit 0 |

## 2. The condition

**Migration 0044 is not applied to DEV, and this session has no DDL capability.**

Independently established (`scripts/ii_r5_schema_probe.mjs`): seven
`exec_sql`-style RPC candidates all HTTP 404; no `DATABASE_URL`; all six R5
tables report `PGRST205`.

Consequently:

* **SEC-R5-001 … 011 BLOCKED** — the six new R5 tables' RLS is written to the
  pattern R4 proved effective, but is **asserted, not proven**.
* **LIVE-R5-005 … 009 BLOCKED** — overlap, multi-fund X-Ray, partial coverage,
  stale holdings and debt scenarios not exercised against live data.
* **Six browser states not seen rendered** — normal X-Ray with holdings,
  partial coverage, stale warning, populated overlap heatmap,
  missing-classification, debt widgets.

Nothing was reported PASS that could not be genuinely evaluated. The harnesses
are written and will evaluate all 22 blocked checks for real the moment 0044 is
applied.

### To close the condition

1. Apply `supabase/migrations/0044_ii_r5_sip_xray_holdings.sql` to DEV
   (idempotent; safe to re-run end to end).
2. `node scripts/ii_r5_schema_probe.mjs` → expect "MIGRATION 0044 FULLY APPLIED: YES".
3. `node scripts/ii_r5_live_dev_security_tests.mjs` → expect 24 PASS / 0 BLOCKED.
4. Seed fund-holdings snapshots and re-run browser QA for the six states above.

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
alter certified behaviour without re-certification. Raised as a separate
follow-up.

## 5. Known limitations, stated plainly

1. Migration 0044 not applied; 22 security/live checks BLOCKED (section 2).
2. Six X-Ray browser states not visually verified (section 2).
3. **Fund-manager concentration deliberately DEFERRED** — no reliable versioned
   metadata source exists. Disclosed in the UI rather than estimated.
4. **Multi-agency credit-rating consolidation suppressed** — no approved
   methodology is configured, so agency-specific data is retained and the
   consolidated view withheld.
5. **Industry exposure** is implemented but produces results only where genuine
   industry classification exists; it is never derived from sector data.
6. Formal performance matrix (1/10/25/50/100 funds × 50/100/250 holdings) **not**
   executed. No N+1 or quadratic-in-holdings pattern found by inspection.
7. The `ii_fund_holdings` R1 table remains in place, unused by R5, which reads
   the new versioned tables instead.

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

1. Apply migration 0044 and close the 22 BLOCKED checks.
2. Complete the six outstanding X-Ray browser states.
3. Resolve the R4 unbounded-read finding (section 4).
4. Product Owner decision on the migration-numbering fork (disclosed, untouched).
5. Product Owner decision on an approved multi-agency credit-rating
   consolidation methodology, if consolidated credit quality is wanted.
6. A real fund-holdings data source, since R5 ships the architecture and
   contract but no production holdings feed.
