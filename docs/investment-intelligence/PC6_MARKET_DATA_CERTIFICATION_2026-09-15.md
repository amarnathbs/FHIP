# PC6 — Reference-Market-Data Certification

**Phase:** M6 of the "Investment Intelligence + AIE-1 Convergence" mission (phase 7 of 11)
**Branch:** `mission/m6-pc6-2026-09-15`, branched from `62b5a09` (M5 terminal)
**Date:** 2026-09-15
**Overall verdict:** **CONDITIONAL PASS**

---

## 0. What "PC6 scope" means in this document

**No original approved PC6 scope exists anywhere in the repository.** This is
not an inference — it is the M0 scope ledger's own recorded finding
(`II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md`, row `SL-PC6`:
*"NOT FOUND (label + binding AIE-1.0 exclusion contract + additive Part N
only)"*). Two label-level references exist (`II_PC4_STATUS_2026_09_07.md:136`
and `AIE_1_MASTER_PLAN.md:122`) and one binding *boundary* contract
(SRC-AIE10 §19, `AIE10-PC6-01..05`), which says what PC6 must **not** absorb
rather than what it must build.

So the mission dispatch's own Part N **is** PC6's scope for this phase. This
document certifies N.1 through N.16 and nothing else. It does not invent a
fictitious "original PC6 requirements" set to layer Part N on top of — exactly
as Phase 5 (M4) did for PC5. Open operator item **OA-1** ("does a prior
approved PC6 requirement set exist?") remains open and is unaffected by this
phase.

---

## 1. Headline verdict and why it is CONDITIONAL, not FULL

PC6's **buildable** scope is complete and proven against real data. What keeps
it CONDITIONAL is three things this phase could not resolve on its own
authority, every one of them named rather than worked around:

| # | Why CONDITIONAL | Nature |
|---|---|---|
| C-1 | Migration `0155` is **not applied** to DEV or production | Environment — no DDL path exists from here (re-proved 2026-09-15) |
| C-2 | **BLOCKER PO-PC6-1** — Indian index levels are licensed, so no real benchmark series can be ingested | Product Owner / commercial |
| C-3 | **BLOCKER PO-PC6-2** — no approved risk-free source; three defensible candidates, materially different answers | Product Owner |

None of the three is a code defect, and none is hidden behind a green tick.
C-2 and C-3 are represented *in the system* as first-class blocked states:
`buildUrl()` throws on a blocked source, `ii_benchmark_category_defaults` and
`ii_risk_free_methodology` ship deliberately empty, and every risk-free row
carries `is_certified = false`.

---

## 2. Per-item verdicts, N.1 – N.16

| Item | Verdict | Evidence |
|---|---|---|
| **N.1/N.2** Scope and boundary | **PASS** | No PC6 module imports anything under `lib/aie/**`; no user-document path routes through PC6. Structural proof: no PC6 table carries a tenancy column (`PC6-PG-29`, 8 tables checked against `information_schema`). §3.1 |
| **N.3** Mutual-fund scheme master | **PASS** | `ii_scheme_master` (0155 §3), effective-dated, one open row per AMFI code enforced by a partial unique index. 350 distinct raw option strings preserved behind 6 coarse filter values (`PC6-LD-08`). §3.2 |
| **N.4** Authoritative source acquisition | **PASS** | AMFI's own public files, verified reachable and parsed: 1,519,199 B / sha256 `b1a8be20…` (`PC6-LD-01..06`). Config-driven endpoints, sha256 fingerprint, deterministic parse, 17 real rejections, content-idempotency, backfill windows. §3.3 |
| **N.5** Daily NAV history | **PASS** | Real AMFI NAVs genuinely written to DEV and verified against a sealed oracle (`PC6-LD-15/16`); future dates rejected (`PC6-LD-20`, plus a DB trigger in 0155); per-series staleness (`PC6-LD-22`); **precision defect found and fixed**. §3.4 |
| **N.6** Statement NAV vs market NAV | **PASS** | `presentDualNav()` returns both facts with their own as-of dates and has no field a caller could mistake for a merged NAV (`PC6-LD-27/28`, 3 unit tests). §3.5 |
| **N.7** Benchmark master | **PASS (schema/governance)** / blocked on data | 0155 §10 adds frequency, source, currency, effective dating, lifecycle and `licence_status`. TRI/PRI discipline enforced. No real index level ingested — C-2. §3.6 |
| **N.8** Scheme → benchmark mapping | **PASS** | Three-basis precedence, effective dating, audited override enforced by a DB CHECK (`PC6-PG-14/15/16`), governed category defaults requiring an approver and a reasoned rationale (`PC6-PG-17`), and `unmapped` as a first-class state (`PC6-PERF-15`). §3.7 |
| **N.9** Benchmark history | **CONDITIONAL** | Ingestion machinery, batch lineage, correction provenance, staleness and the no-future-date trigger are all built and verified. **Zero real benchmark points ingested** — C-2. §3.8 |
| **N.10** Risk-free series | **BLOCKED — named, not guessed** | `ii_risk_free_methodology` created **empty**; three candidates documented with arguments for and against; `classifyRiskFree()` distinguishes `pending_po_decision` from `uncertified_seed`. **BLOCKER PO-PC6-2.** §3.9 |
| **N.11** Data-quality / admin surface | **PASS** | All eight required panels, gated on a separately-named capability at four layers. RLS proven with a vacuity guard (`PC6-PG-18..23`). Manual corrections audited by CHECK. §3.10 |
| **N.12** Performance activation | **PASS** | 19 metrics activated from the already-certified R4/R5 engines against a **real** 14-point AMFI NAV series; 24/24 (`PC6-PERF-01..24`), including a static check that no PC6 module reimplements a metric. §3.11 |
| **N.13** Same-contribution benchmark | **PASS (pre-existing, verified)** | R5's `benchmark-sip-identical-cashflow-r5-v1` already satisfies it. Verified, not assumed: all 13 contributions applied at their own dates, one XIRR over the shared schedule (`PC6-PERF-17/18/19/20`). §3.12 |
| **N.14** Incomplete-history behaviour | **PASS** | Opening-balance-only history withholds since-inception XIRR while current value and NAV-based returns still work, with a user-facing explanation (`PC6-PERF-21/22/23`). §3.13 |
| **N.15** PC6 production jobs | **PASS (DEV only, by design)** | Kill switch failing closed, bounded exponential backoff, four outage modes, partial-batch settlement, alerting, batch ledger, operator runbook. **No production schedule registered** — binding override. §3.14 |
| **N.16** PC6 certification | **PASS** | Sealed oracle on real values (`PC6-LD-16`); exact source-vs-database counts throughout; stale/unavailable states proven by six negative controls. §3.15 |

---

## 3. Evidence

### 3.1 Boundary (N.1, N.2, D.1, D.7)

AIE10-PC6-01..05 require PC6's ingestion to stay completely separate from AIE:
separate jobs, providers, credentials, schemas, lineage, quality metrics and
incident model, and AIE document confidence must never become PC6 data-quality
confidence.

* No file under `lib/services/investment-intelligence/pc6/` or
  `lib/config/investment-intelligence/pc6ReferenceSources.ts` imports anything
  from `lib/aie/**`.
* PC6's job ledger (`ii_reference_import_batches`), rejection log, correction
  ledger and kill switch are all new tables, sharing nothing with
  `aie_audit_event` or the AIE intake lifecycle.
* PC6's quality vocabulary (`ok` / `suspicious_jump` / `stale` / `superseded`,
  and `FreshnessState`) is entirely separate from AIE's extraction-confidence
  model. Nothing converts one into the other.
* PC6 reads no user document and has no user-document code path.

**D.7 — the defining invariant.** `presentDualNav()`
(`referenceDataQuality.ts`) is the only sanctioned way to show a statement NAV
alongside a PC6 NAV. Its signature makes the violation unrepresentable: there
is no parameter that could overwrite `statement`, and no returned field that
merges the two. `PC6-LD-28` asserts the returned key set is exactly
`{asOfLabel, differs, market, statement}`.

### 3.2 Scheme master (N.3)

`ii_scheme_master` carries AMC, AMFI scheme code, scheme name, both ISINs,
plan (raw + normalised), option (raw + normalised), structure, category header
verbatim, category group, subcategory, lifecycle status, inception/closure/
merger dates, merge target, country, currency, source, batch, record checksum
and effective dates. `ii_scheme_alias_history` carries effective-dated name
history separately from R2's curated `ii_scheme_alias_map`.

**Fields AMFI does not publish stay NULL.** AMFI's public files carry no
inception, closure or merger date. Those columns exist and are left empty
rather than inferred — a NULL means "not published", never "assume today".

**Nothing economically distinct is collapsed.** Measured on the live file:

| Measurement | Value |
|---|---|
| Distinct raw AMFI option strings preserved | **350** |
| Coarse `option_type` filter values | 6 |
| Distinct AMFI category headers preserved verbatim | **103** |
| Direct-plan records / Regular-plan / plan not stated by AMFI | 4,294 / 4,312 / 5,738 |

AMFI's own taxonomy contains near-duplicate spellings (`Equity Scheme -` vs
`Equity Schemes -`; `Sectoral/ Thematic` vs separate `Sectoral Fund` and
`Thematic Fund`). All 103 are kept distinct. Merging them would be PC6
inventing a taxonomy AMFI never published.

A blank Plan column maps to `null`, not `'not_applicable'` — the latter would
assert something AMFI never said.

Structural proof (`PC6-PG-08..13`): a second *open* row for the same AMFI code
is refused by `uidx_ii_scheme_master_current`; a superseding period opens once
the prior is closed; two distinct plan/option variants coexist as separate
current rows; a `merged` scheme with no merge target is unrepresentable.

### 3.3 Source acquisition (N.4)

| Source | Endpoint | Licence | Status |
|---|---|---|---|
| AMFI daily NAV | `https://portal.amfiindia.com/spages/NAVAll.txt` | public_open | **In use** |
| AMFI NAV history | `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=…&todt=…` | public_open | **In use** |
| AMFI scheme master | same as daily NAV (AMFI publishes no separate master file; NAVAll.txt *is* the master) | public_open | **In use** |
| NSE Indices (NIFTY TRI/PRI) | — | licence_required | **BLOCKED** (PO-PC6-1) |
| BSE (SENSEX) | — | licence_required | **BLOCKED** (PO-PC6-1) |
| India risk-free | — | po_decision_required | **BLOCKED** (PO-PC6-2) |

A host note worth recording: `www.amfiindia.com` was **not reachable** from
this environment on 2026-09-15 (connection refused at the IP layer, 14.143.46.156).
`portal.amfiindia.com` — AMFI's own portal host, serving byte-identical paths —
was. The portal host is the configured endpoint; the canonical www address is
retained in configuration as documentation.

Measured on the live files:

| | NAVAll.txt | NAV history (3-day window) |
|---|---|---|
| Bytes | 1,519,199 | 3,486,515 |
| sha256 | `b1a8be20149399454ec9a12f620af499657e9fde3c3b12cd85e755414f062cab` | `08aef515269f16a1e7e9…` |
| Total lines / data lines | 18,062 / 14,361 | 28,709 / 26,152 |
| Accepted | **14,344** | **26,152** |
| Rejected | **17** | 0 |
| Distinct category headers / AMCs | 103 / 54 | 97 / 53 |
| NAV date range within one file | **2008-10-02 .. 2026-09-14** | 2026-09-08 .. 2026-09-10 |

The two formats have **different column orders** and are parsed by two
different functions rather than one "flexible" parser — a flexible parser is
how a column-order change becomes silent corruption instead of loud failure.

**All 17 rejections are real.** Every one is the literal NAV string `"10."`,
published by AMFI for matured target-maturity index funds. `Number("10.")`
returns `10`, so a lenient parser would have invented a fact; the strict
decimal grammar rejects it with an exact reason and the source line number.
Rejection rate 0.118%, well under the 5% format-change alert threshold.

Idempotency is **by content, not by presence**: each record carries a checksum
over its identity and value, and a re-import of identical content plans zero
writes (`PC6-LD-17`: 11/11 previously-written records re-planned, 11 skipped,
0 rewrites).

### 3.4 Daily NAV history (N.5) — and a real defect found

**A real defect, found by real data and confirmed live on DEV.**
`ii_prices_nav.price` was created by migration `0033` as `numeric(20,6)`. AMFI
publishes NAVs with up to **eight** decimal places:

| Decimal places | Rows in NAVAll.txt (2026-09-15) |
|---|---|
| 0–4 | 13,868 |
| 5 | 6 |
| 6 | 27 |
| **7** | **54** |
| **8** | **389** |
| malformed | 17 |

At scale 6 the importer must either reject 3.1% of the real universe or round
it silently. `PC6-LD-18` proves the consequence **on the live DEV database**:
writing a real 8-dp AMFI NAV returns a rounded value. Migration `0155` widens
the column to `numeric(24,10)` — a metadata-only change in Postgres, no
existing row rewritten, no value altered — and `PC6-PG-04` confirms an 8-dp
value then stores intact as `14.8626963200`.

Other N.5 controls:

* **Exact scheme mapping** — identifier-only, AMFI code then ISIN. No fuzzy or
  name matching (`PC6-LD-13` negative control). A code/ISIN disagreement is
  reported as `AMBIGUOUS_ISIN_CONFLICT` rather than resolved by precedence.
* **Date uniqueness** — `unique(instrument_id, price_date)` from 0033; an
  in-file conflicting duplicate is rejected and the first occurrence kept.
* **No future dates** — rejected at the parser against a caller-supplied as-of
  date (`PC6-LD-20`: re-parsing with `asOfDate=2020-01-01` produced 11,983
  `FUTURE_DATE` rejections) and, once 0155 is applied, by a DB trigger that
  also fires on a direct service-role insert (`PC6-PG-05`). The trigger allows
  one day of slack for the IST/UTC boundary.
* **Non-negative/valid** — a published `0.0000` is a real fact, not a missing
  value: 241 real schemes publish exactly zero (wound-up segregated
  portfolios), and all are accepted (`PC6-LD-26`).
* **Stale detection, per series** — this matters more than it looks. One
  download of NAVAll.txt contains rows dated 2008 through yesterday, so "the
  file is from today" would present an 18-year-old price as current.
  `PC6-LD-22` shows the same file yielding `fresh` (1 day) and `stale`
  (6,557 days) verdicts from the same download.
* **Holiday/missing-date semantics** — PC6 maintains **no Indian trading
  holiday calendar** and does not pretend to. Weekends are recognised
  arithmetically; any remaining weekday hole is reported as a gap for a human
  to judge. Nothing is ever interpolated (`PC6-LD-24`).
* **Correction provenance** — a changed value for the same (scheme, date) is a
  source correction: a new row with `correction_of_id`, the prior row marked
  `superseded` with `superseded_by_id`, and an `ii_reference_corrections` entry
  recording both values (`PC6-LD-19`).
* **No cross-tenant duplication** — structurally impossible: no PC6 table has a
  tenancy column (`PC6-PG-29`).

### 3.5 Statement NAV vs market NAV (N.6)

Both are preserved and labelled. `PC6-LD-27` renders:

> Statement NAV 412.5500 as at 2026-03-31; market NAV 418.9100 as at 2026-09-14 (source: amfi).

A disagreement is **displayed, never resolved**. When no market NAV exists the
label says so explicitly rather than leaving a blank.

### 3.6 / 3.7 Benchmark master and mapping (N.7, N.8)

0155 completes the master with frequency, source, currency, effective dating,
`lifecycle_status` and `licence_status`. Mapping gains `mapping_basis` plus
audited-override columns.

**Precedence is `admin_override` → `scheme_disclosed` →
`governed_category_default`, and there is no fourth option.** There is
deliberately no "inferred", "fuzzy" or "best guess" basis, and no fallback to
"the country's main index". `unmapped` is a first-class result with five
distinct reasons, and it degrades coverage honestly: the certified engine
counts an unmapped holding in the coverage *denominator*, so coverage falls and
the conclusion is suppressed below the 80% threshold rather than the holding
contributing a 0% benchmark return (`PC6-PERF-15`).

**Governance is enforced by the database, not only by code**
(`PC6-PG-14..17`): an admin override without actor, timestamp and a ≥20-character
reason is refused by CHECK; an override claiming an external source as its
authority is refused; a category default without a reasoned rationale is
refused. `ii_benchmark_category_defaults` ships **empty** — asserting that, say,
every large-cap fund benchmarks to NIFTY 50 is precisely what N.8 forbids.

**TRI/PRI:** a PRI series standing in for a required TRI is `acceptable` but
`qualified` and annotated as understating the benchmark; an incompatible type
(e.g. a gold index for a required TRI) is refused outright.

**BLOCKER PO-PC6-1.** NIFTY index values are the property of NSE Indices
Limited and SENSEX of BSE/Asia Index; neither is open data. The legacy
unauthenticated `niftyindices.com/Backpage.aspx/getTotalReturnIndexString`
endpoint was re-probed on 2026-09-15 and now returns the HTML site shell rather
than data, so there is not even a technical path, let alone a licensed one.
`buildUrl('nse_index_tri')` **throws** (`PC6-LD-37`). DEV was checked: of its 14
benchmark rows, **zero** are named after a real licensed index — they are all
pre-PC6 R4/R5 synthetic test fixtures (`PC6-LD-39`).

### 3.8 Benchmark history (N.9)

Date-aligned history, total-return handling, corrections, staleness,
provenance and missing-data behaviour are all built: `ii_benchmark_series`
gains `import_batch_id`, `record_checksum`, `superseded_by_id` and
`source_as_of`, plus the same no-future-date trigger (`PC6-PG-07`). Missing
data is handled by the certified engine's own last-observation-on-or-before
semantics, never by interpolation.

**Zero real benchmark points ingested** (C-2). This is why N.9 is CONDITIONAL
rather than PASS: the machinery is proven, the data is licence-blocked.

### 3.9 Risk-free series (N.10) — BLOCKER PO-PC6-2

N.10 explicitly permits naming this as a blocker rather than silently picking a
proxy, and that is what PC6 does.

There is **no approved risk-free source** anywhere in the repository. The only
risk-free data that exists is 16 rows in DEV whose own `source` column reads
*"DEV SEED — approximate RBI 91-day T-Bill annual average (not a certified
feed)"* — the seed labels itself as not a source of truth. PC6 neither promotes
nor deletes them, and `PC6-LD-40` confirms all 16 still carry that label.

Three defensible candidates, documented with arguments both ways:

| Candidate | For | Against |
|---|---|---|
| RBI 91-day T-Bill cut-off | The conventional short-rate proxy; genuinely default-free; matches the short horizon of monthly risk metrics | Auction-driven; some weeks have no auction, so it needs an explicit carry-forward rule |
| 10-year benchmark G-Sec yield | Daily, liquid, tenor-matched to a long-horizon equity investor | Carries duration risk, so not risk-free over shorter holding periods; understates excess return on a steep curve |
| RBI policy repo rate | Unambiguous, stepwise, never revised, easy to explain | A policy instrument, not a traded return — an investor cannot actually earn it |

They differ by roughly 100–150 bp across 2024–2026, which visibly moves every
Sharpe and Sortino number. PC6 will not choose. What PC6 ships: the versioned
effective-dated shape, a **mandatory** methodology record (`ii_risk_free_methodology`,
created empty), `is_certified` defaulting false on every rate, a three-state
classifier separating `governed` / `uncertified_seed` / `pending_po_decision`,
and resolution that returns `unavailable` rather than a default. The certified
risk engine already handles the absence correctly: with no risk-free series,
Sharpe and Sortino report `MISSING_REFERENCE_DATA` while volatility still
calculates (`PC6-PERF-09`) — rf = 0 would have made every Sharpe look better
than it is.

### 3.10 Admin surface (N.11)

Eight panels: NAV freshness, scheme mapping gaps, benchmark mapping gaps,
import batches (covering failed batches and last successful job), outliers,
source corrections, risk-free freshness, job control — plus a ninth listing the
blocked sources.

**Admin Architecture Standard compliance.** Capabilities affected: one new,
`can_view_reference_data_quality`.

| Clause | How it is met |
|---|---|
| §2 capability-based access | A separately-NAMED capability with its own `admin_users` column and its own predicate — never bare `requireAdmin()`. Follows the LR-9 precedent (0132) exactly |
| §4 four-layer enforcement | DB: `is_pc6_reference_data_admin()` backs RLS on every PC6 operational table. API: `requireReferenceDataAdmin()`. Page: `requireReferenceDataAdminPage()`. Nav: `lib/admin/adminNav.ts`. Denial is an explicit 401/403, never a 200 with an empty list |
| §5 least privilege | Read-only. No POST/PATCH/DELETE exists on this surface |
| §6 privileged DB access | No cross-user aggregate RPC is needed — there is no user data to aggregate |
| §7/§9 privacy | **Stated as a finding, not an omission:** every table here is global reference data with no tenancy column at all. No user_id, no names, no financial records, no user-authored free text; no row count varies with how many users hold a scheme. The suppression model has nothing to bite on because there is no person in the data |
| §8 result states | Exactly `ok` / `unavailable`. `never_ingested` is distinct from `stale`. Never a bare 0 for "unknown" |
| §12 metric certification | Each panel's definition, source tables and limitations are documented in the route's own header and in the runbook |
| §13 safe failure | An unknown `?panel=` is a 422; a missing table (0155 unapplied) is `unavailable` with the reason, never a healthy empty dashboard; capability read failures fail closed |
| §14 no scope expansion | One nav entry, one capability, one route, one page. Incidental findings recorded in §5 rather than fixed |
| §15 rollback | `update admin_users set can_view_reference_data_quality = false`, or the kill switch — both in the runbook |

Exceptions requested under §16: **none**.

**Manual corrections are audited** (N.11's own requirement):
`ii_reference_corrections` is append-only with no update or delete policy, and
its CHECK refuses an admin correction without an actor id and a ≥20-character
reason — so a direct service-role insert cannot bypass it either.

RLS proven with a **vacuity guard** (`PC6-PG-18..23`): an admin *without* the
capability sees 0 import batches; an admin *with* it sees 1; an ordinary user
sees 0 but can still read the public scheme master; `ii_scheme_master` has no
non-SELECT policy at all. The harness asserts `auth.uid()` really is the
intended user before making any claim, so none of these is hollow.

### 3.11 Performance activation (N.12)

**No analytics were reimplemented.** Every number comes from an engine
certified in R4/R5 and imported unmodified. A static check (`PC6-PERF-24`)
scans all seven PC6 modules — `amfiParser`, `benchmarkGovernance`,
`referenceDataAdmin`, `referenceDataQuality`, `referenceImportRunner`,
`referenceIngestJob`, `riskFreeSeries` — for any metric implementation and
finds none. The check reads the directory rather than a hard-coded list, so a
future module cannot slip past it.

Driven with a **real** NAV series: 14 month-end NAVs for AMFI code 120503
("Axis ELSS Tax Saver Fund — Direct Plan — Growth Option"), assembled from 14
bounded real fetches of AMFI's history endpoint, 2025-07-31 .. 2026-08-31.

| Metric | Verdict | Value produced |
|---|---|---|
| Current valuation | activated | 1,210.9329 units × 112.9309 = ₹136,751.75 |
| XIRR | activated | 0.089803 |
| CAGR / point-to-point | activated | 1M 1.22%, 3M 8.27%, 6M 3.67%, 1Y 5.42%, since inception 4.15% (CAGR 3.82%) |
| TWRR | activated | chain-linked over 13 sub-periods |
| Volatility | activated | 0.16515 annualised, 13 observations |
| Downside volatility | activated | calculated |
| Sharpe | activated | −0.080649 |
| Sortino | activated | −0.109852 |
| Max drawdown | activated | −0.139101 |
| Beta | activated | 0.504651 |
| Alpha | activated | calculated |
| Tracking error | activated | calculated |
| Information ratio | activated | calculated |
| Upside/downside capture | activated | calculated |
| Calmar | activated | 0.274773 |
| Rolling returns | honest `unavailable` | a 14-month series cannot support a 1-year rolling *series*, and the engine says so rather than producing one |
| Benchmark growth | activated | point-to-point 0.024447, CAGR 0.022528 |
| Active return | activated | 0.038195 − 0.022528 = 0.015667 (CAGR vs CAGR) |
| Blended benchmark | activated | 14 rebalance boundaries, full coverage |

**The benchmark series is synthetic and labelled `SEALED-ORACLE-SYNTHETIC`
everywhere.** Because of C-2 there is no real Indian index series for PC6 to
supply. It is never written to any database and never given a real index's
name. It proves the engines *activate* once a benchmark exists; it does **not**
mean FHIP can show a user a real NIFTY comparison today.

Negative controls: no risk-free series ⇒ Sharpe/Sortino withheld while
volatility still calculates; no benchmark ⇒ beta/alpha/TE/IR/capture withheld;
missing benchmark side ⇒ active return unavailable, not the scheme return.

### 3.12 Same-contribution benchmark (N.13)

**Already satisfied by R5, and verified rather than assumed.** R5's
`calculateBenchmarkSip` (`benchmark-sip-identical-cashflow-r5-v1`) builds a
synthetic benchmark investment receiving the identical cash-flow schedule:
`units_i = Contribution_i / BenchmarkLevel(date_i)`, terminal value from total
synthetic units, then one XIRR over the same dates and amounts.

`PC6-PERF-17`: all 13 contributions applied at their own dates; 133.2612
synthetic units; terminal ₹134,061.73. `PC6-PERF-18`: one XIRR (0.053796) over
13 dated flows plus one terminal value — **no per-contribution XIRR is computed
anywhere in the path**, so a weighted average of individual XIRRs is not merely
avoided, it is absent. `PC6-PERF-19`: excess return 0.036007, labelled "SIP
benchmark excess return", never "alpha". `PC6-PERF-20`: a truncated benchmark
history makes the **whole** comparison unavailable — a partial-period comparison
is never presented as a full one.

PC6's contribution to N.13 is supplying the benchmark series. That remains
blocked by C-2.

### 3.13 Incomplete history (N.14)

With `history_completeness = 'opening_balance_only'`, since-inception XIRR is
withheld (`INSUFFICIENT_HISTORY`), **but** current value and all five NAV-based
point-to-point horizons still work — incomplete *transaction* history does not
invalidate a *price* fact. The withholding carries a user-facing explanation
(`PARTIAL_TRANSACTION_HISTORY`), not a silent blank.

### 3.14 Production jobs (N.15)

| Control | Implementation | Proof |
|---|---|---|
| Idempotency | Content checksum; a re-run plans zero writes | `PC6-LD-17`, unit test |
| Retry/backoff | 15→30→60→120→240→360 min, **capped at 6 h** so a week-long outage is still probed | `PC6-LD-31`, 3 unit tests |
| Alerting | Partial batch and rejection-rate spike ⇒ critical; a healthy real run raises none | `PC6-LD-35/36` |
| Kill switch | DB row, **fails closed** when absent; a reason is required to disable | `PC6-LD-29/30`, `PC6-PG-26` |
| Partial-batch atomicity | `commit_chunks` with an honest partial status, or `all_or_nothing` returning `rolled_back` | `PC6-LD-33/34` |
| Operator runbook | `PC6_OPERATOR_RUNBOOK.md` | — |
| Source outage | Four distinct modes; a truncated body is an outage, never "a small day" | `PC6-LD-32` |

**The partial-batch choice is deliberate and worth stating.** PC6 commits
chunks rather than all-or-nothing, because a NAV row is an independent dated
fact and 9,000 good prices are not made wrong by the 9,001st failing. But a
partial batch is **never** reported as `succeeded` — it settles as `failed`
with exact committed/failed counts, so the job stays in backoff and the
freshness surface keeps showing a problem until a complete run happens. A
partial batch silently reported as success is the failure mode that matters.

**No production schedule is registered.** Migration 0155 contains no
`cron.schedule` call at all (`PC6-PG-27/28`), both control rows ship
`enabled = false` (`PC6-PG-26`), and no Vault secret was created. Per the
binding override, activation is a deferred human-present step, written up in
runbook §9 with the exact statements to run.

### 3.15 Certification method (N.16)

* **Sealed oracle on real values** (`PC6-LD-16`): 11 NAV rows read back from
  DEV and compared to the exact values in the source file — 0 mismatches.
* **Exact source-vs-database counts** throughout: 14,361 data lines → 14,344
  accepted → 11 resolvable against DEV's 21-code / 31-ISIN index → 11 written →
  11 read back → 12 deleted (11 plus the precision probe).
* **Stale/unavailable states proven**, not asserted: six negative controls
  across the live-DEV and activation matrices.
* **Determinism**: the same bytes produce identical record checksums across two
  parses (`PC6-LD-06`), over all 14,344 records.

---

## 4. Test and evidence summary

| Suite | Result | What it is |
|---|---|---|
| `scripts/pc6_0155_pglite_verification.mjs` | **30 / 30 PASS** | Full chain 0001..0155 replayed from empty into real Postgres (PGlite), then 0155 re-applied to prove idempotency |
| `scripts/pc6_live_dev_matrix.ts` | **41 / 41 PASS** | Real AMFI fetch + real writes to the real DEV database, cleaned up and verified |
| `scripts/pc6_performance_activation_proof.ts` | **24 / 24 PASS** | 19 metrics activated from the certified engines over a real 14-point AMFI series |
| `tests/unit/pc6ReferenceMarketData.test.ts` | **79 / 79 PASS** | Parser, quality rules, governance, risk-free states, N.15 controls |
| **PC6 total** | **174 / 174 PASS** | |
| Repo-wide `tsc --noEmit` | **0 errors** | |
| ESLint on every touched file | **clean** | |
| Full `vitest run` | **16 files / 22 tests failing** | **Exactly the pre-existing baseline.** None is a PC6 file |

**Real data volumes.**

| Quantity | Count |
|---|---|
| AMFI source records parsed | 14,361 (daily) + 26,152 (3-day history) + 14 monthly windows |
| Scheme records accepted | 14,344 |
| Records rejected, all genuinely malformed | 17 |
| Distinct AMFI scheme codes observed | 14,344 |
| Distinct AMCs / category headers / raw option strings | 54 / 103 / 350 |
| NAV rows genuinely written to DEV and then removed | 12 |
| Benchmark points ingested | **0** — licence-blocked (C-2) |
| Risk-free rows certified | **0** — PO decision open (C-3) |
| DEV `ii_prices_nav` row count before / after | **258 / 258** |

---

## 5. Incidental findings (recorded, not fixed — Standard §14)

1. **DEV fixture ISINs fail their check digit.** `INF204K01UN8`, present in
   DEV's `ii_instruments`, is not a valid ISO 6166 ISIN. Found when a first
   draft of a unit test copied it from a DEV row and the parser correctly
   dropped it. Pre-existing fixture data, not a PC6 defect, but it means ISIN
   resolution against DEV is narrower than its row count suggests.
2. **Cron auth documentation drift.** `ENVIRONMENT_VARIABLES.md:11` and
   `OPERATIONS_RUNBOOK.md:17` describe cron auth as
   `Authorization: Bearer <CRON_SECRET>`; the code has always used an
   `x-cron-secret` header. PC6's route follows the code, not the docs.
3. **`scripts/db-rebuild-check/README.md` is stale** — it says `@electric-sql/pglite`
   is deliberately not in `package.json`; it has been a real dependency since
   `package.json:54`.
4. **No repo-wide job-run table existed before PC6.** "Did the scheduled job
   run?" was answerable only from pg_cron's internals. PC6 introduces one for
   its own jobs; the two existing sweeps still have none.
5. **No existing cron job has a kill switch.** PC6 introduces one for its own
   jobs only.

---

## 6. Blockers requiring Product Owner input

**PO-PC6-1 — benchmark index data licensing.** NIFTY belongs to NSE Indices
Limited, SENSEX to BSE/Asia Index. Neither is open data, and the legacy
unauthenticated endpoint no longer works. Until a licence exists, PC6 ingests
no index level and all benchmark-relative metrics correctly report
`unavailable`. *Decision needed:* obtain a licence, or accept that FHIP shows
no benchmark comparison for Indian mutual funds.

**PO-PC6-2 — risk-free source and methodology.** Three defensible candidates
(§3.9), differing by 100–150 bp, which visibly moves every Sharpe and Sortino.
*Decision needed:* choose a source and tenor, and approve a gap-handling rule.
Once chosen, the only work is a governed methodology row plus an importer for
that one source.

**Neither blocks Phase 8.** PC7 (mutual-fund look-through) depends on PC6's
scheme master and security master, not on benchmarks or risk-free rates.

---

## 7. Deferred operational steps (human-present)

1. Apply migrations `0153`, `0154`, `0155` to DEV, then production.
2. Grant `can_view_reference_data_quality` to the intended admin(s).
3. Create the Vault secret and register the pg_cron schedule (runbook §9).
4. Flip the kill switch on after observing a dry run.

None was performed by this phase, and none could have been: no DDL path exists
from this environment, and the binding override prohibits autonomous
production activation.
