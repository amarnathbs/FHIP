# NAV2 - Benchmark and risk-free dependency register

Evidence label: code-complete / unit-tested for the contracts; **no data exists for either dependency in any environment from this branch**, so every dependent metric returns a typed unavailable state until Stage 2 loads data. Risk-free source research and the first-load provenance live on the audit worktree (`docs/nav2/BETA_ALPHA_RISK_FREE_SOURCES_RESEARCH_2026-10-03.md` and `docs/nav2/risk_free_first_load/RISK_FREE_FIRST_LOAD_PROVENANCE.md` with the two CSV files); their evidence labels are the author's own and are not re-verified here.

## 1. Which metric needs which dependency

| Metric | Benchmark (BENCH-1) | Risk-free series | Without it |
|---|---|---|---|
| point-to-point, absolute, CAGR, daily / log, rolling | no | no | n/a |
| volatility, max drawdown, SMA / EMA / ROC, high / low, mean / median, correlation, ranking | no | no | n/a |
| Sharpe, Sortino | no | **yes** | `risk_free_missing` |
| beta | **yes** | no | `benchmark_missing` |
| Jensen alpha | **yes** | **yes** | `benchmark_missing` first (alpha is never shown without beta), then `risk_free_missing` |
| XIRR, current value, invested, gain / loss (investor family) | no | no | n/a |

## 2. Risk-free series (PO decisions of 03-10-2026)

| Item | Decision / state |
|---|---|
| Primary | `RBI_91D_TBILL_CUTOFF_YIELD`: RBI 91-day Treasury bill auction cut-off yield, cadence `weekly_auction`. Staleness 21 days from the latest auction observation (three weekly cycles) |
| Secondary | `RBI_POLICY_REPO_RATE`: RBI policy repo rate, cadence `policy_change` (only CHANGES are recorded: the repo rate can sit unchanged for years). Freshness is measured from the dataset's `verifiedThroughDate`, window 90 days (PO-CONFIRM) |
| Ids and cadence words | identical to the PO's first-load CSV files (`series_id`, `frequency` = `weekly_auction` / `policy_change`) |
| Selection | `NAV2_RISK_FREE_CONFIG.selectedSeriesId` (default primary); the series switch changes Sharpe, Sortino and alpha to the other series' hand-computed values (tested) |
| Source terms | **PO decision 03-10-2026: written confirmation from RBI is NOT required.** Recorded as `termsReviewStatus = 'po_accepted_2026-10-03'`. Stated factually: RBI publishes no explicit reuse licence (its pages say "All Rights Reserved"; its disclaimer restricts caching, linking and framing without written permission). This is a **PO-accepted risk**, not a granted licence, and stays visible in the dataset, the config note and this register. (`pending_confirmation` still exists as a status that prints a "terms still being confirmed" notice; `declined` switches the series off.) |
| Attribution | "Source: Reserve Bank of India", printed with every figure built on the series |
| Switch | `NAV2_RISK_FREE_CONFIG.enabled` (master) and `RiskFreeDataset.enabled`; either false, or terms `declined`, makes every dependent ratio `risk_free_missing` / `risk_free_series_disabled`; nothing is deleted |
| Ingestion | **Latest PO decision: a weekly refresh job reads RBI's HTML (section 5), default OFF; the admin upload stays as the manual and correction path.** This supersedes the earlier "admin upload only, no scraping" instruction of the same day. The NAV2 engine itself never fetches |
| Observation (CSV columns) | `observation_date`, `value_percent` (annualised percent as published), `source_document`, `source_url`, `retrieved_on`, `notes`; contract adds `kind` (`value` / `gap`), `gapReason`, `entryKind`, `extraction` (release number, method, version, checks passed) |
| Gap rows | a GAP row has no value and is never itself used as a rate; it documents that no cut-off exists for that date. Rule of 04-10-2026 (PO). A gap row means "no cut-off exists for that date" (reasons: `no_accepted_bids`, `no_auction_held`, `no_row_in_source`). The 21-day staleness window stays the general rule. A weekly rate also carries forward across DOCUMENTED gap rows for at most 35 calendar days from the last VALUE observation (`riskFreeGaps.maxCarryAcrossDocumentedGapDays`), and only while the records from that observation to the date (the value, each gap row, the date) are no more than 14 days apart (`documentedGapMaxRecordSpacingDays`): an undocumented hole never carries, and beyond 35 days the date has no rate. A carried rate is labelled "carried across a documented RBI gap" in the disclosure and in the provenance (`periodsCarriedAcrossDocumentedGap`, `documentedGapDatesCrossed`). |
| Dataset | id, name, source, attribution, cadence, version, retrieval date, terms status, enabled, staleness, verified-through date |
| Semantics | the latest VALUE observation on or before the date, never a future one, never interpolated, never older than the staleness rule; looked up at each return interval's START date. Window-level rule (changed 04-10-2026; before it ONE date without a rate made the whole ratio `risk_free_missing`): a Sharpe, Sortino or alpha is computed over the return observations that HAVE a rate, provided at least 95% of the window's return observations do (`riskFreeGaps.minWindowCoverageShare`); below that, or with none, it is `risk_free_missing`. The number left out is disclosed (`risk_free_periods_excluded`) and stored in the provenance (`periodsExcluded`, `excludedDates`, `windowReturnCount`, `windowCoverageShare`). Alpha takes its means over the same kept observations; beta stays the one computed on every common return. |
| Conversion | `(1 + y/100)^(1/N) - 1`, N = 252 / 52 / 12 matched to the return frequency (hand-checked to 1e-14) |
| Shipped data | none in code. The first-load CSVs (1,060 T-bill rows from 05-04-2006 to 30-09-2026; 61 repo change rows from 26-10-2005 to 05-12-2025) are the PO's Stage 2 upload input. The DEV seed in `ii_risk_free_rates` ("not a certified feed", 0043) is not read |
| Validation | invalid date; observation dated after its retrieval (future); yield outside 0-100 (unit mistake); missing source document; conflicting duplicate; gap row carrying a value or with no reason: dropped and reported. A dataset with no id / name / source / attribution / version / valid retrieval date, or an invalid verified-through date, is unusable |
| Provenance printed | series name, yield at the window start and end, the auction / decision dates used, dataset version, retrieval date, terms status, verified-through date, staleness, cadence, conversion, attribution (`RiskFreeProvenance.disclosureText`) |
| Monitoring signal | `riskFreeFreshness(dataset, today)`: days since the last auction (T-bill) or last verification (repo) against the named window; `fresh` / `stale` / `no_data`. A silently broken refresh therefore shows as `stale` AND as `risk_free_missing` in the ratios |
| Supersedes | PC6 blocker PO-PC6-2 ("risk-free source not chosen") is resolved for NAV2; `pc6/riskFreeSeries.ts` and the R4 Performance tab's rate lookup are untouched |

Caveat the PO should keep in mind (research note): Indian fund factsheets use one overnight MIBOR value over a 3-year monthly window, so a NAV2 Sharpe on the 91-day T-bill will differ from a factsheet Sharpe. Every ratio prints its series, window and conversion for that reason.

Known data characteristics from the first load (affect Stage 2 only): 5 auctions with no accepted bids and 8 Wednesdays with no row are NOT in the T-bill CSV (they become gap rows or stay absent); some auctions fall on non-Wednesdays (the 27-08-2026 release is a Thursday); four 2010-2011 values are the least certain (price and yield disagree in the Handbook table); the repo CSV records changes only, which is why the repo series is a `policy_change` series.

## 3. Benchmark (BENCH-1, PO decision item 3)

| Item | State |
|---|---|
| Governed series | BENCH-1 Phase 2 (migration 0241): catalogue, per-right entitlement records, `benchmark_entitled_actions()`. **Currently no licensed series exists** (PO statement), so beta and alpha return `benchmark_missing` with no number today |
| Gates (all must hold) | mapping effective for the whole analysis window and not changing inside it; entitlement allows calculation AND customer display; catalogue verified; total-return series (price index or unknown refused); published levels. Implemented once (`segmentGateFailure` in `holdingBenchmarkComparison.ts`, extracted for NAV2 and now shared with the holding-period comparison) |
| Category reference | the read-time `categoryReference.ts` table (UNVERIFIED rows, never stored, never primary) may feed beta / alpha only with its honest label and only through the same gates. A declared mapping always wins |
| Data scope | the loader clamps series to the entitled data-date scope (`clampToScope`); NAV2 does not re-check it |
| Provenance emitted | benchmark id, key, label, basis (declared or category reference) and its basis label, return type, dataset version, licence status, effective mapping dates, first and last observation dates, common observation count |
| Alignment | common dates only; the benchmark's extra days are dropped; fewer than 60 common returns while the scheme has enough is `benchmark_missing` / `benchmark_overlap_insufficient` |
| Not decided here | whether category-reference beta / alpha should be shown to customers at all while the category table is UNVERIFIED and no licensed series exists (PO) |

## 4. Stage 2 design: risk-free storage and admin upload (migration numbers 0260 and higher)

Reuse the Market Index Data pattern (migration 0232, `lib/services/investment-intelligence/marketIndex/*`), which solves the same problem (admin CSV upload of reference levels, required attestation, append-only audit, no overwrite of a published value, idempotent on file hash, shipped-disabled feed):

1. Tables: `ii_risk_free_series` (id, name, cadence, staleness, enabled, terms status, verified-through date), `ii_risk_free_observations` (series, observation date, value or gap, gap reason, source document, source URL, retrieved on, notes, entry kind, extraction JSON, batch id; unique on series + date; RLS read for authenticated, no direct writes) and an append-only `ii_risk_free_batches` ledger (uploader or job, SHA-256, row counts, date range, attestation text).
2. `commit_risk_free_upload()` SECURITY DEFINER RPC in the `public` wrapper pattern (Admin Architecture Standard 6.1): `auth.uid()` plus a NEW named capability `can_upload_risk_free_data` evaluated inside the function (standard section 2), fixed `search_path`, all-or-nothing transaction, refuses any row that would silently change a published value (a different value for the same series and date is a recorded correction with a reason, never an overwrite), idempotent on file hash, `EXECUTE` revoked from `PUBLIC` and `anon`. The first-load CSVs load through it. A second RPC for the refresh job (service role only) appends publish decisions and review items through the same validation.
3. Admin page and API under the existing Admin shell with four-layer enforcement (database, API, route, navigation), direct-URL, direct-API and database-bypass tests (standard section 4), explicit 401 / 403 (never an empty 200), row-level CSV errors; the review queue (section 5) lives here and publishing from it needs the same capability.
4. A loader that builds `RiskFreeDataset` objects (`datasetVersion` = the latest committed batch id) for `selectRiskFreeSupply()`.
5. Monitoring: the freshness signal on the admin dashboard (`unavailable` when no data exists, never zero: standard section 12).
6. `enabled` and the terms status move from config to a governed, audited row so the PO can switch the series off without a deploy.

Admin Architecture Standard: Stage 1 touches no admin surface (no `app/(app)/admin/**`, `app/api/admin/**`, navigation, role or capability). It becomes mandatory for items 2 and 3 in Stage 2; the capability named above is the only one NAV2 introduces.

## 5. Stage 2 design: the weekly risk-free refresh job

Stage 1 delivers the contracts and the publication gate (`lib/engines/nav2/riskFreeRefreshGate.ts`, tested); Stage 2 builds the job around them.

**1. Trigger and switches.** A weekly cron route, protected by `CRON_SECRET` like the other cron routes, shipped with its kill-switch row in the existing job-control mechanism (`ii_reference_job_control`, job key `nav2_risk_free_weekly_refresh`, `enabled = false`, the row seeded by a migration >= 0260) and a **dry-run mode** (reads and decides, writes nothing; the default for the first runs). `planRefreshRun()` encodes it: kill switch off = zero requests, dry run = no writes.

**2. Sources.** (a) The RBI "Treasury Bills: Full Auction Result" press release for the latest Wednesday auction, found through RBI's press-release listing in its monthly archive form (the form the first-load research used: open the month list once, read the titles, open only the matching release; release numbering `2026-2027/<n>`, page `BS_PressReleaseDisplay.aspx?prid=<id>`, about 115,000 bytes, row III holds the 91-day cut-off price and YTM; the weighted-average yield in row VI is NOT the cut-off yield). (b) The RBI weekly NSDP page (`BS_NSDPDisplay.aspx?param=4`) for the weekly 91-day yield and the policy repo rate, both to two decimals, as the cross-check. Politeness is a tested constant (`RISK_FREE_REFRESH_FETCH_POLICY`): descriptive User-Agent, at most 4 requests per run, 4 s spacing, conditional requests, robots.txt honoured, 1 MB and 15 s per-request caps, 60 s run deadline, no PDFs, never a human-verification bypass (the `rbidocs` host showed a human-verification page to scripted downloads: that host is not used).

**3. Extraction.** The deterministic parser FIRST: release number, title, date, and the row "Cut-off price / Yield" for the 91-day column. The AI extraction (the existing AIE / OpenAI schema-extraction stack with a strict JSON schema returning the same `ParsedAuction` shape) is BOTH the fallback when the parser fails AND an independent second opinion when it succeeds. `decideTbillRefresh()` publishes automatically only if: (a) parser and AI agree, or one read is missing and the NSDP cross-check matches; (b) the yield recomputed from the printed cut-off price, `(100 - P) / P x 365 / 91`, matches the printed yield within 0.001 percentage points; (c) the value is within 0.5 percentage points of the previous observation and, when the NSDP page has the week, equals it at two decimals (an NSDP mismatch always blocks; an unavailable NSDP is allowed only when both reads agree, the band applies, and the date is a Wednesday); (d) the date is a weekday later than the last stored one (a Thursday needs the NSDP match). Anything else is a review item with its evidence (both readings, the NSDP reading, the last stored value, the checks), published nowhere.

**4. Storage.** Append-only, idempotent: a re-run of the same week writes nothing (`noop_duplicate`); a different value for a stored date is a review item, never an overwrite. Per-observation provenance: press release number, URL, retrieved-on, extraction method (`parser` / `ai` / `parser+ai`) and version, the checks that passed, batch id.

**5. Edge cases.** No auction held, or the release not yet published or published late: `no_release_yet`, nothing written, the next run retries, and `daysOverdue()` raises an alert after the expected Wednesday. No accepted bids (cut-off cells "-"): a GAP row with `no_accepted_bids`, never a value. A RBI page layout change (parser fails and AI fails): review item and alert, never a guess.

**6. Repo rate.** `decideRepoRefresh()`: the NSDP weekly policy repo equal to the stored rate advances the dataset's `verifiedThroughDate` and writes no observation; a different value is only a SIGNAL: a new row is appended only with the Monetary Policy Statement press release as evidence (agreeing with NSDP, effective date after the stored one and not in the future) or an administrator's confirmation, otherwise it is a review item.

**7. Staleness is visible.** The staleness rule makes a silently broken job show up in the product: no observation within 21 days (T-bill, plus documented-gap carrying up to 35 days) or no verification within 90 days (repo) leaves those dates without a rate, and a window with under 95% coverage is `risk_free_missing`. The admin dashboard shows the `riskFreeFreshness()` signal (days since last observation / verification vs the window) per series.

**8. Tests for Stage 2** (the gate's negative controls already pass in Stage 1 on synthetic readings): fake HTML fixtures SYNTHESISED from the real release structure (never a committed RBI page) for the parser, with named controls: parser / AI disagreement never publishes; recompute mismatch never publishes; a duplicate week writes nothing; kill switch off makes no request; no accepted bids creates no value; layout change goes to review; late release retries; robots.txt disallow stops the run; the per-run request cap and spacing hold.

## 6. Open dependency decisions for the PO

1. Repo-rate verification window 90 days (and the weekly NSDP check that advances it).
2. Whether beta / alpha may be shown on the category-reference benchmark while that table is UNVERIFIED and no licensed series exists.
3. Whether the risk-free `enabled` flag and terms status should be admin-switchable in Stage 2 (recommended) or stay a config change.
4. The plausible-band width (0.5 percentage points week on week) and the AI second-opinion cost / model for the weekly run (one short call a week).
5. The two same-day instructions on ingestion ("admin upload only, no scraping" and "automate weekly") conflict; this branch follows the later one (automation, default off, admin upload retained). Please confirm.

## 7. Stage 2 build status (what exists now)

Evidence: unit-tested and PGlite-verified. **Nothing is applied, no data is loaded anywhere, and the readers have not been run against the live RBI site.**

| Piece | State | Where |
|---|---|---|
| Storage (series registry, observations, batch ledger, review queue, corrections, state log), the two capabilities, the RPCs | built, PGlite-verified (76 checks) | migration 0260 |
| Admin upload (preview, attested commit), review queue, correction, series switch; four-layer enforcement | built, unit-tested | `app/(app)/admin/investment-intelligence/risk-free-data`, `app/api/admin/investment-intelligence/risk-free-data/**`, `riskFreeAdmin.ts` |
| First load of the PO's two CSV files | the files parse completely (1,060 and 61 rows, none rejected); loading is the PO's step | `docs/nav2/po_apply_0260_0262/README.md` |
| Loader into the engine's dataset contract (deterministic dataset version) | built, unit-tested | `riskFreeDatasetLoader.ts` |
| Weekly refresh job: polite fetcher, HTML readers, AI second opinion (behind the AIE gateway and its switch), gate-driven decisions, review items, gap rows, repo verified-through, cron route | built, unit-tested with synthetic pages; **default OFF and dry run by default** | `rbiFetcher.ts`, `rbiHtml.ts`, `rbiSource.ts`, `rbiAiReader.ts`, `riskFreeRefreshJob.ts`, `app/api/investment-intelligence/cron/nav2-risk-free-refresh` |
| Monitoring of freshness | built: the admin screen and the monitoring snapshot show days since the last observation / verification against the window, per series | `RiskFreeDataClient.tsx`, migration 0262 |

Design points that differ from the sketch in section 5, all deliberate:

- The repo rate: a change seen on NSDP always becomes a review item with NO candidate row. The monetary-policy-statement reader was NOT built (changes are rare); the administrator confirms a change by uploading a row. `decideRepoRefresh` still accepts policy evidence, so a reader can be added without changing the gate.
- Gate hardening: a GAP already stored for a date with a value now on the release is a review item (it was published automatically before).
- robots.txt is read once per run outside the 4-page budget (so a run is at most 5 requests); an unreadable robots.txt stops the run before any page is requested.
- Conditional requests (If-None-Match / If-Modified-Since) are supported by the fetcher but no validators are stored between runs (there is nowhere to store them without another table), so every run fetches in full.
- The archive-form request for a listing of a month other than the one the page shows by default is inferred from a saved copy of the page; it is the least certain part and is what the DEV dry run must confirm first.

Open decisions this adds, for the PO: (1) DECIDED 04-10-2026 (see section 8); (2) whether the weekly job should read the Monetary Policy Statement itself; (3) whether to persist conditional-request validators.

## 8. Documented gaps and window-level availability (PO decision 04-10-2026)

Rule of 04-10-2026 (PO). A gap row means "no cut-off exists for that date" (reasons: `no_accepted_bids`, `no_auction_held`, `no_row_in_source`). The 21-day staleness window stays the general rule. A weekly rate also carries forward across DOCUMENTED gap rows for at most 35 calendar days from the last VALUE observation (`riskFreeGaps.maxCarryAcrossDocumentedGapDays`), and only while the records from that observation to the date (the value, each gap row, the date) are no more than 14 days apart (`documentedGapMaxRecordSpacingDays`): an undocumented hole never carries, and beyond 35 days the date has no rate. A carried rate is labelled "carried across a documented RBI gap" in the disclosure and in the provenance (`periodsCarriedAcrossDocumentedGap`, `documentedGapDatesCrossed`).

Window-level rule (changed 04-10-2026; before it ONE date without a rate made the whole ratio `risk_free_missing`): a Sharpe, Sortino or alpha is computed over the return observations that HAVE a rate, provided at least 95% of the window's return observations do (`riskFreeGaps.minWindowCoverageShare`); below that, or with none, it is `risk_free_missing`. The number left out is disclosed (`risk_free_periods_excluded`) and stored in the provenance (`periodsExcluded`, `excludedDates`, `windowReturnCount`, `windowCoverageShare`). Alpha takes its means over the same kept observations; beta stays the one computed on every common return.

**What this does to the PO's first-load T-bill file (measured, not assumed).** Every weekday from 05-04-2006 to 30-09-2026 has a rate under the plain 21-day rule: the three stretches longer than 14 days (11-09-2024 to 03-10-2024, 12-02-2025 to 27-02-2025, 18-03-2026 to 08-04-2026) are 22, 15 and 21 days between auctions, so no date inside them is older than 21 days (the date of the later auction has its own value). The earlier statement in the first-load README that 02-10-2024 and 03-10-2024 would be unavailable was wrong and is corrected. Loading the documented gap rows therefore changes no figure for this dataset; it records WHY those Wednesdays have no value, and it protects any longer analysis if a longer stretch ever occurs (a second consecutive missing auction, or a late weekly job).

**The gap rows.** `RBI_91DAY_TBILL_GAP_ROWS.csv` (next to the two first-load files) lists the 13 distinct dates from `RISK_FREE_FIRST_LOAD_PROVENANCE.md` section 5: 5 auctions with no accepted bids (27-01-2016, 24-02-2016, 29-03-2023, 20-02-2025, 25-03-2026; reason `no_accepted_bids`) and 8 Wednesdays with no row in the tables (05-01-2011, 17-07-2013, 01-04-2015, 30-09-2020, 18-09-2024, 25-09-2024, 31-12-2025, 01-04-2026; reason `no_row_in_source`, because RBI does not say whether an auction was held). The three stretches are not extra dates: they are already made of these (18-09-2024 and 25-09-2024; 20-02-2025; 25-03-2026 and 01-04-2026). The count is 13, not 16, because 5 + 8 + the three stretches double-counts. The file loads through the admin upload like any other (the upload format already carries `kind` and `gap_reason`); the data rows were not edited.
