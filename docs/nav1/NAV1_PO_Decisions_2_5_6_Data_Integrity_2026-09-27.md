# NAV 1 — PO Decisions #2, #5, #6: Data-Integrity Findings and Fixes (2026-09-27)

Branch `fix/nav1-integrity-mergers-reports-2026-09-27`, off `origin/main` @ `d7e0ae7`. Production: read-only throughout — every finding below that touches production came from GET-only PostgREST calls or public AMFI/TIGZIG HTTP reads, never a write. No production migration was applied by this dispatch.

## #5.1 — The disambiguated numbers (up front, as requested)

**Subject:** exactly one scheme — **HSBC Short Term Fund**, AMFI scheme code **151069**, formerly filed under **L&T Mutual Fund** before an AMC/fund-house ownership change. `instrument_id = 003c7324-14e7-47a2-b842-64aeb9cdcbc1`. ISIN (growth) `INF917K01IS0`.

**What the numbers count:** stored `ii_prices_nav` rows for this ONE instrument, re-verified for rehydration fidelity — i.e. "if this history were ever deleted, could the same values be re-fetched from an approved source?" They are **not** a universe-wide count, not a count of schemes, not a count of missing/expected observations against some external total. Today's stored data is intact; nothing is currently missing from storage.

**Re-confirmed live against production, 2026-09-27** (via `scripts/nav1_d11_source_fidelity_check.ts`, then again via the new `scripts/nav1_report_dependency_restoration_attempt.ts` built this dispatch — two independent tools, same result):

| Quantity | Value |
|---|---|
| Total pre-changeover rows on file (2013-01-28 → 2026-09-18) | **3,199** |
| Recoverable from an approved source today (AMFI, 2 chunks, 2022-09-20 → 2026-09-18) | **925** exact matches, 0 mismatches |
| Unrecoverable from either approved source (5 chunks of up to 730 days, 2013-01-28 → 2022-09-19) | **2,274** |
| Providers checked per unrecoverable chunk | AMFI (fund-house code 37 = HSBC's current code) **and** TIGZIG — both `not_found` |
| Held by any production user today | **No** — 0 rows in `ii_transactions`, `ii_holding_snapshots`, `ii_portfolio_truth_status` |
| Benchmarked / report-pinned / under a hold | **No** to all three |
| `ii_nav_history_floors` row | None |

This matches the 2026-09-25 Stage-E readiness canary's finding (925/3,199) exactly, two days and roughly 5 newly-collected daily rows later (production total is now 3,204, all 5 new rows on/after the changeover, hence still 3,199 pre-changeover).

**Root cause:** AMFI's NAV History Report groups records by fund house. This scheme kept its own AMFI code (151069) throughout its sponsor change, but its pre-2022-09-20 records are not served under HSBC's current fund-house code (37) — and TIGZIG, independently, also has nothing for the same window. 2022-09-20 is an **empirically observed** boundary from this replay (the date the earliest AMFI-servable chunk begins), not an asserted legal merger date — recorded that way deliberately, since this dispatch did not independently verify the corporate-action date.

**Of the 5 Stage-E canary funds tested on 2026-09-25, only this one has any gap.** The other 4 (HDFC NIFTY 50 ETF, Baroda BNP Paribas Money Market, Reliance Fixed Horizon XXVI-9, Tata Floating Interest Rates) were 100% recoverable. This is the **only known instance** of this class of problem anywhere in production today — see the honest limitation on universe-wide scope below.

## #5.2 — Does migration 0200's merge-family predicate cover every known merger?

**Enumerated, read-only, 2026-09-27:** zero rows in `ii_instruments.merged_into_instrument_id` and zero rows in `ii_scheme_master.merged_into_instrument_id`, across the whole production database. Unchanged since the same check on 2026-09-25. **The merge-family mechanism has never protected a real case** — by this project's own standing lesson (see `migration_drop_recreate_constraint_trap` / `negative_controls_must_demonstrably_break`), a control that has never fired is not proven, only plausible.

**More importantly: this mechanism is the wrong lever for the one real case found.** `merged_into_instrument_id` models a SCHEME absorbed into a DIFFERENT scheme — two AMFI codes, two `ii_instruments` rows, one linked to the other. HSBC Short Term Fund kept its own AMFI code throughout; there is no second "L&T Short Term Fund" instrument row anywhere to link. The real event is an AMC/fund-house ownership change on a *continuing* scheme — a different, more common event in the Indian mutual-fund industry (L&T → HSBC, Principal → Sundaram, IDFC → Bandhan, Daiwa → Sundaram, Morgan Stanley → HDFC, and others), and one this codebase had no first-class representation for at all.

**Fix (migration 0219):** added `ii_nav_source_coverage_gaps` (see #2 above) and `ii_scheme_master.predecessor_amc_name`, and hardened `pc6_nav_row_is_candidate()` to protect any row inside an unresolved coverage gap independent of held status. The 0200 merge-family mechanism itself is left unchanged — it is architecturally correct for its own scenario (a true scheme-to-scheme merger) and may yet be exercised by a real future case; this dispatch did not find one to test it against.

**Not done, disclosed honestly:** a full scan of the ~14,336-instrument AMFI universe for *other* undiscovered AMC-transition gaps was not attempted. Doing so properly would require re-running the fidelity check (multiple external AMFI/TIGZIG fetches per instrument) across the whole universe — thousands of requests, hours of runtime, and real risk of tripping AMFI's rate limiting (as NAV 1's own hydration work found the hard way on 2026-09-24). This is recommended as its own scoped follow-up, not silently declared complete here. What IS confirmed: none of the 17 instruments any production user actually holds show this pattern — their full stored history was independently reconciled against the PO's own AMFI master file on 2026-09-24 with 0 mismatches (see `nav1_selective_history_programme.md`), which would not be true if any held fund had an unrecoverable-but-undiscovered gap of this kind.

## #5.3 — Predecessor-to-successor lineage as a first-class relationship

`ii_scheme_master.merger_date` already existed as a column (added when the merge-family concept was designed) but was null everywhere in production — it captures *a* date but not *who the predecessor was*. Migration 0219 adds `predecessor_amc_name text` and populates both columns for the one confirmed case:

```
merger_date = '2022-09-20', predecessor_amc_name = 'L&T Mutual Fund'
-- for ii_scheme_master where amfi_scheme_code = '151069'
```

This makes the lineage fact queryable (`select scheme_name, predecessor_amc_name, merger_date from ii_scheme_master where predecessor_amc_name is not null`) rather than living only in a report's prose. It is deliberately a *name-level* fact, not an instrument-to-instrument link, because — as established in #5.2 — there is no second instrument to link to.

## #5.4 — Reconciling the "925 AMFI-recoverable" observations concretely

The 925 recoverable observations are the daily NAVs for HSBC Short Term Fund (AMFI 151069) from **2022-09-20 to 2026-09-18** (the two most recent 730-day chunks of the pre-changeover range), all sourced from AMFI (0 from TIGZIG — AMFI answered first for every one of those two chunks), all 925 values matching byte-for-byte what is already stored in `ii_prices_nav`. There is no ambiguity to resolve further: these are not "925 missing values now recovered" — they were never missing; this is a rehydration-fidelity count confirming that if this specific 4-year window were ever deleted, all of it could be restored, while the earlier 2013-01-28→2022-09-19 window (2,274 rows) could not.

## #5.5 — Could the approved TIGZIG fallback help with the remaining gap?

**No — investigated and confirmed, not assumed.** TIGZIG was queried for the exact same 5 unrecoverable chunks, both on 2026-09-25 (canary) and again on 2026-09-27 (this dispatch, via `scripts/nav1_d11_source_fidelity_check.ts` and independently via `scripts/nav1_report_dependency_restoration_attempt.ts`). Both times TIGZIG returned zero observations for every one of the 5 chunks, exactly matching AMFI's `not_found`. TIGZIG's fallback role, bounded-failure trigger, and governance (never silently overwrites AMFI, quarantine-on-conflict via `decideUpsert`, visible provider stamping via `data_version`) are unchanged by this dispatch and were not touched. No new, unapproved source was introduced or considered, per the PO's explicit instruction. **Plain statement: TIGZIG cannot recover this gap. Neither approved source can.** The only path back is a Supabase backup/PITR restore (already flagged BLOCKED in the 2026-09-25 certification — no Management-API/restore access exists in this sandbox), which this dispatch did not have access to attempt or re-check.

## #5.6 — Disclosure at render time

**Found:** the live Investment Intelligence performance dashboard (`app/api/investment-intelligence/analytics/route.ts` → `lib/engines/investment-intelligence/analyticsOrchestrator.ts`'s `runAnalytics()`) recomputes every request from current `ii_prices_nav` data and had **no concept at all** of "this figure rests partly on history that could not be restored if lost." (Finalized Module 9 reports are a separate, already-frozen-snapshot mechanism — see #6.)

**Fix:** a new, additive `DataQualityFlag` value, `UNRECOVERABLE_HISTORY_PERIOD` (`lib/engines/investment-intelligence/dataQuality.ts`), and a pure post-processing function `attachUnrecoverableHistoryDisclosure()` (`lib/engines/investment-intelligence/navCoverageDisclosure.ts`) that appends a plain-language annotation to any scheme (and its portfolio currency block) with an open `ii_nav_source_coverage_gaps` row. Wired into `app/api/investment-intelligence/analytics/route.ts` immediately after `runAnalytics()` — the certified engine itself is untouched; this is a read-only enrichment step using the SAME `annotations: DataQualityAnnotation[]` field the engine already exposes for every other data-quality disclosure, so the existing UI (`PerformanceClient.tsx`'s `<AnnotationList items={s.annotations} />`, already rendered per scheme) shows it with zero UI code changes. 15 + 6 new unit tests (`tests/unit/pc6ReportNavDependencyIntegrity.test.ts`, `tests/unit/navCoverageDisclosure.test.ts`) prove the disclosure fires for an affected scheme, leaves an unaffected scheme's object reference untouched (cheap on every request), never alters a computed figure, and correctly targets only the affected currency's portfolio block.

**Honest limitation:** because HSBC Short Term Fund is not held by any production user, this disclosure has not fired in production and cannot be screenshotted end-to-end this dispatch without fabricating a test holding (which this dispatch chose not to do, consistent with never inventing production-shaped data). It is proven correct by the pure-function unit tests above, which exercise the exact same code path with real, if synthetic, gap data.

## #5.7 — Never splice predecessor and successor returns without a documented continuity rule

**Checked, not assumed:** grepped the whole codebase for any read of `merged_into_instrument_id` outside `pc6_nav_row_is_candidate()` (0200/0219) itself. None exists — no XIRR, TWRR, or rolling-return computation anywhere joins across a merge link or blends two instruments' NAV/cash-flow series. Since zero real merge links exist in production (see #5.2), and HSBC Short Term Fund's history is one continuous series under one instrument_id throughout (no splicing is even structurally possible for an AMC-transition case), **there is currently nothing being spliced anywhere, so the PO's continuity rule is trivially satisfied by absence today.**

**What was deliberately NOT built:** a full continuity-rule engine for a scenario with zero real cases. If a genuine scheme-to-scheme merger is ever recorded (a `merged_into_instrument_id` link populated for real), any future code that tries to build one continuous return series across that link **must** first consult a documented, verified continuity rule — this dispatch did not build that table because inventing its shape ahead of a real case would be speculative. This is flagged, not silently deferred: the right place to add it is right where `merge_family` is walked in `pc6_nav_row_is_candidate()` (0200/0219), the moment a second real link appears.

---

## #6 — Missing finalized-report NAV dependency: fail-closed, not silent recalculation

**Already true, verified by reading the code (not assumed):**
- **(a) Immutable, exactly-as-issued output.** `reportsData.ts`'s `generateReport()` writes `report_sections.section_data_json` once, at generation time, as the engine's raw result object. `getReport()`/`getReportByRenderToken()` only ever `SELECT` — neither recomputes anything.
- **(c) Never silently recalculates.** Confirmed via `app/api/reports/[id]/retry/route.ts`: retry only applies to a report already `status = 'failed'`, always calls `generateReport()` fresh (a brand-new row), and archives the old failed row — it can never touch an already-succeeded, viewable report.
- **(e) A regenerated version is a new report, never an overwrite.** `reports.version_number` / `revises_report_id` / `status = 'superseded'` is a real, already-working version chain used by both the retry and revise routes.
- **(f), partially.** `ii_report_nav_dependencies` (0172) + `pc6_nav_row_is_candidate()` already exclude a report-pinned instrument/date-range from Stage-E deletion candidacy. Migration 0219 extends this further: an instrument inside an *unresolved coverage gap* is excluded regardless of whether any report happens to be pinned to it yet.

**Genuinely missing, and built this dispatch — (b): a queryable alert when an already-recorded dependency stops resolving.** New table `ii_report_nav_dependency_alerts` (migration 0223, self-contained name — checked against every migration and the whole codebase for a collision with any other in-flight "alert"/"coverage" mechanism; none exists as of this dispatch). New detector `checkReportNavDependencyIntegrity()` (`lib/services/investment-intelligence/pc6/reportNavDependencyIntegrity.ts`, pure logic; `reportNavDependencyAlertLive.ts`, orchestration; `reportNavDependencyAlertSupabase.ts`, the real Supabase-backed client) — for each recorded `ii_report_nav_dependencies` row, measures real NAV coverage (row count in range, boundary presence within a 7-day tolerance for non-trading days) and opens/refreshes/resolves an alert accordingly. **Never touches `reports`, `report_sections`, or `report_snapshots`.** 15 unit tests (`tests/unit/pc6ReportNavDependencyIntegrity.test.ts`) prove: a healthy dependency raises no alert (negative control), a fully-wiped range raises exactly one alert with the right detail, re-checking a still-broken dependency refreshes rather than duplicates, coverage restoration resolves the alert without deleting its history, and a fresh break after a real resolution opens its own new row rather than reopening the old one. 9 PGlite tests (`scripts/nav1_0223_pglite_verification.mjs`) prove the same shape against real Postgres semantics: the partial-unique-index dedup, cascade-on-report-delete, the range CHECK constraint, and admin-only RLS (verified for anon, an ordinary authenticated user, and even the report's own owner).

**(d) A controlled restoration attempt is possible.** `scripts/nav1_report_dependency_restoration_attempt.ts` (new, this dispatch) replays the exact same approved AMFI→TIGZIG fetch path over a given instrument/date range, reports whether it is fully, partially, or not recoverable, and — only in `--apply` mode, hard-refused against anything but the `dev` target — writes recovered rows (upsert, never overwriting an existing value) and resolves the matching coverage-gap row only if the *entire* requested range came back. Run for real, dry-run, against production for the HSBC Short Term Fund case on 2026-09-27: confirms **not recoverable**, consistent with #5.5. **Honest limitation:** the `--apply` write path shares its actual write mechanism (`writeRows`) with the already-live-proven hydration job, but this dispatch did not independently live-exercise `--apply` end-to-end against DEV (would need a deliberate delete-and-restore proof, same shape as the earlier `nav1_d11_dev_rehydration_proof.ts`) — recommended as the next concrete step before relying on this tool for a real incident.

## What genuinely cannot be fixed, and why

- **The 2,274-row HSBC Short Term Fund gap itself is not fixable with data this dispatch has access to.** Both approved sources confirm zero coverage for 2013-01-28 → 2022-09-19. The only remaining path is a Supabase backup/PITR restore, which remains BLOCKED (no Management-API/restore access in this sandbox, unchanged since 2026-09-25).
- **A full-universe scan for other undiscovered AMC-transition gaps** was not attempted (cost, not lack of will) — see #5.2.
- **A live, screenshotted proof of the render-time disclosure** was not obtained, since no held production instrument is currently affected — see #5.6.
- **The restoration script's `--apply` path** was proven correct by dry-run logic and code reuse, not by an independent live DEV write-and-restore rehearsal — see #6(d).

## PO-run steps, if any

1. **Migrations `0219` and `0223`** (additive; both PGlite-verified 17/17 and 9/9, and the full 192-migration chain replays clean including them) — apply to DEV first, then production, in that order, same as every prior NAV1 migration. Neither drops or recreates any existing object; `0219`'s `create or replace function pc6_nav_row_is_candidate` is additive (one new OR branch) and keeps the exact same signature and STABLE volatility as 0200's version.
2. **No other production write is requested or required by this dispatch.**
3. Optional, PO's own timing: run `scripts/nav1_report_dependency_restoration_attempt.ts prod 003c7324-14e7-47a2-b842-64aeb9cdcbc1 2013-01-28 2022-09-19` periodically (dry-run only; it never writes against `prod`) in case AMFI or TIGZIG ever backfill this scheme's pre-2022 history — the tool will report it and, if run with `--apply` against `dev` after copying the same gap there, restore it.
