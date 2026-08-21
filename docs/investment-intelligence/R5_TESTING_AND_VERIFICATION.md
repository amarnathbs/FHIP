# R5 — Testing and Verification

Evidence categories are kept strictly distinct throughout: **UNIT**,
**INTEGRATION**, **INDEPENDENT**, **LOCAL-DB**, **LIVE-DEV**, **BROWSER**,
**ADVERSARIAL**. A result is never promoted from a weaker category to a
stronger one.

---

## 1. Baseline reproduction (before any R5 change)

Run by this session on the R5 branch at its creation point (`f1f509a`), not
inherited from R4's report.

| Check | R4 certified | R5 reproduced | Status |
| --- | --- | --- | --- |
| Unit/integration tests | 669 passed, 5 skipped | **669 passed, 5 skipped** | REPRODUCED |
| TypeScript | clean | **clean (exit 0)** | REPRODUCED |
| ESLint | — | **6 errors, 6 warnings** (all pre-existing, none in II paths) | RECORDED as baseline |
| R4 50-case certification | 50/50 | **34 tests pass** across `iiR4Certification50Case`, `iiR4MathIdentities`, `iiR4DataQualityAndFabrication` | REPRODUCED |
| R4 oracle regeneration | deterministic | **byte-identical** (`git diff --ignore-cr-at-eol` clean) | REPRODUCED |
| R4 analytics-forgery closure | closed | **10/10 live PASS** | REPRODUCED |
| Migration 0043 applied to DEV | yes | **confirmed live** (0043 columns present, 0035 `subject_type` absent, `ii_risk_free_rates` exists) | REPRODUCED |
| Production build | clean | **clean (exit 0, 175 routes)** | REPRODUCED |

**NOT REPRODUCED:** R4's own LIVE-R4/SEC-R4 pack was not re-run wholesale; the
specific R4 security property R5 could regress (analytics forgery) was re-tested
directly instead, and passes.

## 2. Final static verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **clean** |
| `npx eslint .` | **6 errors, 6 warnings** — byte-identical to baseline; **zero new errors, zero new warnings** |
| `npx vitest run` | **800 passed, 5 skipped** (baseline 669 + 131 R5) |
| `npx next build` | **exit 0**, 175 routes, all 7 R5 routes present |

The 6 baseline lint errors are pre-existing and in unrelated files
(`forecast/goals/page.tsx`, `AdminBenchmarksClient`, `AdminRecommendationsClient`,
`FinancialDataGrid`, `RecommendationsPanel`, `AppShell`). None are in
Investment Intelligence paths.

> **Build note.** A first build attempt failed at static-export time with
> "@supabase/ssr: Your project's URL and API key are required". That was the
> worktree lacking `.env.local`, not an R5 defect — the compile step had already
> reported "✓ Compiled successfully". Re-run with the environment present, the
> build completes cleanly. Recorded because a bare "build failed" line in a log
> would otherwise be misleading.

## 3. R5 test inventory (131 tests)

| Suite | Tests | Category |
| --- | --- | --- |
| `iiR5Certification.test.ts` | 91 | INDEPENDENT (698 metric comparisons vs the Python oracle) |
| `iiR5MathIdentities.test.ts` | 20 | UNIT (property/identity assertions) |
| `iiR5NoFabrication.test.ts` | 20 | UNIT ("unavailable is never zero") |

## 4. Independent certification

See `R5_INDEPENDENT_CERTIFICATION.md`. Summary:

**89/89 cases · 698/698 comparisons · 0 failures.**
Max variance anywhere **5.749e-08** against a 1e-6 XIRR tolerance.
Oracle imports no production code and uses a different XIRR algorithm.
Both negative controls executed green → red → green.

## 5. Live-DEV verification (LIVE-DEV + ADVERSARIAL)

### 5.1 What could and could not be tested

Migration 0044 is **not applied** to DEV and this session has **no DDL
capability** — independently established, not assumed
(`scripts/ii_r5_schema_probe.mjs`: seven `exec_sql`-style RPCs all 404, no
connection string, all six R5 tables `PGRST205`).

The **SIP path reads only tables that already exist**, and persistence to the
new tables is deliberately non-fatal. The SIP half was therefore exercised
**fully end-to-end against real DEV data through the real HTTP API**. The X-Ray
half's look-through scenarios could not be.

### 5.2 Live SIP end-to-end — 26/26 PASS

`node scripts/ii_r5_live_sip_e2e.mjs` → **PASS=26 FAIL=0 BLOCKED=0**

This harness is **genuinely independent**, not production-called-twice. For
each scenario it: seeds known data into the real DEV database; computes the
expected answer **itself** using its own bisection XIRR, importing no
production module; calls the real HTTP API as a real authenticated user
(constructed `@supabase/ssr` session cookie); compares; and inspects the
returned versioning/as-of metadata.

Selected results:

| ID | Check | Evidence |
| --- | --- | --- |
| LIVE-R5-001 | Monthly SIP actual XIRR | API 0.11992726381797947 vs independent 0.11992726381802721 — **variance 4.774e-14**; terminal ₹227,448.64 exact |
| LIVE-R5-004 | Benchmark SIP over identical cash flows | API 0.08994552554984915 vs independent 0.08994553305367103 — variance 7.504e-09 |
| LIVE-R5-004b | Identical schedule | **36 applied contributions vs 36 actual**, every date and amount matching |
| LIVE-R5-004c | Excess return | label "SIP benchmark excess return", API 0.029981738 vs independent 0.029981731, variance 7.5e-09 |
| LIVE-R5-002 | Missed contribution | gap `2022-11-07 → 2023-01-07` reported, `skippedPeriods=1`, `consistencyPct=0.958` |
| LIVE-R5-003 | SIP + lump sum | series ending value **₹84,428.09**, NOT the whole-fund ₹393,688.53 |
| LIVE-R5-003b | Mixed position disclosed | `positionIsMixed=true` |
| LIVE-R5-NOBENCH | No benchmark mapping | `MISSING_BENCHMARK`, rate `null`, excess unavailable |
| LIVE-R5-NOBENCH-b | Actual return survives | still `ok`, rate 0.06994214 |
| LIVE-R5-ASOF | As-of correctness | `asOfDate=2024-06-28`, `navDateUsed=2024-06-28`, `navAtAsOf=149.772442` |
| LIVE-R5-XRAY-ZERO | 0% coverage | `available=false`, `topHoldings` **omitted**, `sectorExposure` **omitted** |
| LIVE-R5-SIM | Simulation | 3/3 variants ok, `classification=SIMULATION` |
| LIVE-R5-SIM-b | Flat total | API ₹210,000 = independent 42 × ₹5,000 |

**Independent live reconciliation count: 8** (LIVE-R5-001, 004, 004b, 004c,
003, NOBENCH, SIM-b, ASOF) — exceeding the required minimum of 5.

### 5.3 A real defect found by this harness

The **first** run failed 4 of 24 checks. Root cause: PostgREST silently caps an
unbounded select at 1000 rows, reporting truncation only in `Content-Range`.
Reproduced in isolation: 1500 seeded `ii_prices_nav` rows returned exactly 1000
with `Content-Range: 0-999/1500`.

Symptoms produced: schemes with complete NAV reporting spurious "NAV
unavailable"; the as-of cap landing on a wrong, too-early date (2024-01-07
instead of 2024-06-28); simulations failing `ALIGNMENT_FAILED` on funds whose
prices were fully present.

Fixed by a `fetchAllRows()` paging helper applied to every large time-series
read, each with a deterministic secondary sort. After the fix: **26/26 PASS**.

**This defect was invisible to unit tests, code review, and the 89-case
certification pack** — all of which use in-memory fixtures. Only live testing
against a real database exposed it.

> **Finding against the certified R4 baseline.**
> `lib/services/investment-intelligence/analyticsRepository.ts` has the **same**
> four unbounded reads (`ii_transactions`, `ii_holding_snapshots`,
> `ii_prices_nav`, `ii_benchmark_series`) with no `.range()` and no `.limit()`.
> R4 is very likely affected. It was **deliberately not changed here**, because
> it is certified R4 code and altering it would change certified behaviour
> without re-certification. Reported for a separate follow-up.

### 5.4 Security pack

See `R5_SECURITY_VERIFICATION.md`.

* Analytics-forgery regression: **10 PASS / 0 FAIL**
* API-layer security (live, through the app): **8 PASS / 0 FAIL**
* New-R5-table security pack: **2 PASS / 0 FAIL / 22 BLOCKED** (0044 outstanding)

## 6. Browser QA (BROWSER)

See `R5_BROWSER_QA.md`. Conducted in a real browser as a real logged-in user.

Passed: SIP overview with data; **benchmark-unavailable rendering "Not
available" rather than 0.00%**; gap/pause states; SIP detail with charts,
consistency, assumptions and timing; labelled simulation with three variants;
**the mandatory 0%-coverage X-Ray negative control** (0 charts, 0 SVGs,
0 tables, 0 occurrences of "0.00%"); overlap-unavailable with no heatmap;
correct separate as-of dates; and a full-page language sweep finding 0 advisory
phrases and 0 mentions of "alpha".

**Not covered:** normal X-Ray with real holdings, partial coverage, stale
holdings, a populated overlap heatmap, missing-classification rendering, and
debt widgets — all require migration 0044.

## 7. Integration / no-regression

| Property | Evidence |
| --- | --- |
| No net-worth change | `r5Repository.ts` contains no write to any financial register; the only mutation is derived-analytics persistence via service role |
| No phantom assets from look-through | Weight identity asserted to sum to exactly 1; effective values sum back to the portfolio value |
| R3 publication lifecycle unaffected | No R3 table is written; full suite (which includes the R3 pack) passes 800/800 |
| R4 calculations unaffected | R4's 34 certification/identity/fabrication tests still pass; R4 engine files untouched |
| Goals not duplicated | R5 writes nothing to goals |
| Forecasting not auto-fed | No R5 output is written to any forecasting assumption table; simulations are explicitly labelled and go nowhere near planning inputs |

## 8. Performance sanity

Not formally benchmarked across the 1/10/25/50/100-fund matrix. What is known:

* The overlap matrix computes only the upper triangle and mirrors it —
  n(n−1)/2 pair computations, not n². Acknowledged as naturally ~O(n²) in fund
  count.
* The 10-fund matrix case (45 pairs) computes within the certification suite's
  overall 2.3s runtime alongside 88 other cases.
* All engine code is pure and allocation-light; look-through is a single pass
  over funds × holdings.
* The `fetchAllRows()` paging helper adds one round trip per 1000 rows and
  carries a 500,000-row defensive ceiling.

**Honest status:** no N+1 or quadratic-in-holdings pattern was found by
inspection, and no realistic-portfolio browser freeze was observed, but a
formal performance matrix was **not** executed.

## 9. Determinism proof

* `generate_cases.mjs` regenerates `cases.json` **byte-identically**.
* `fingerprintSipInputs()` / `fingerprintXrayInputs()` canonicalise numbers to
  fixed decimal strings and dates to ISO before hashing, so identical certified
  inputs produce an identical SHA-256 and identical results on rerun.
* All engine functions are pure with deterministic ordering (every sort has an
  explicit tie-break).
