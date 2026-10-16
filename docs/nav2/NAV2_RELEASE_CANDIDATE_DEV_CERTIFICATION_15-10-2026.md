# NAV2 release candidate: DEV certification (Phases A to E)

Written 15-10-2026 (the DEV runs are dated 14-10-2026 UTC). **DEV only. Nothing was pushed, merged to main, or applied to production. No production credential was looked for or used.** Scope of this document: Phases A to E of the mission and the D10 table. Phases F to K (production) were not started.

## Verdict

**NAV2 RELEASE CANDIDATE: DEV CERTIFICATION CONDITIONAL, NOT FULLY CERTIFIED. PRODUCTION NOT STARTED.**

The unconditional section 21 wording ("NAV2 RELEASE CANDIDATE: DEV CERTIFIED, PRODUCTION NOT STARTED") is NOT used, because two release-critical gates are incomplete and rounding up is not allowed. Everything else passed (the table below has 20 PASS rows, 8 CONDITIONAL PASS rows, 1 NOT APPLICABLE row for beta and alpha, 1 NOT STARTED row for production, and no FAIL row):

1. **DEV catalog inventory, retention-function identity and the DEV proof of migrations 0281 and 0282 are BLOCKED on the Product Owner running the DEV pack** (`docs/nav2/po_apply_dev_release_candidate/`). Everything that can be done without DDL on DEV was done; the REST-level comparison shows exactly the two expected differences (the two 0281 columns and the 0282 function). Idempotency-under-concurrency and the held-back statement-line count are therefore PGlite-verified and unit-tested only.
2. **A report for 20 funds was not shown to finish reliably on DEV from the development machine** (details in B3). 1, 4 and 10 funds finish. **Resolved by Product Owner decision on 15-10-2026: the pilot limit is 10 funds per report (see the update below the verdict).** The measurement is dominated by a 170 ms round trip and a home link, so it says nothing certain about production, but the mission rule is that the pilot limit is lowered when 20 cannot finish with margin. The code keeps the Product Owner's number (20) because it is a recorded Product Owner decision; **the recommended pilot limit is 10 funds per report** (one constant and the tests that name it).
The full unit suite comparison, the type check, the lint and the production-style build are complete (section E): no new failure against a clean origin/main remains.

**Update 15-10-2026 (Product Owner decision, after this report was first written): the NAV2 pilot limit is 10 funds per report.** Done on this branch: `FUND_ANALYTICS_MAX_FUNDS` is 10 (`lib/config/nav2/reportLimits.ts`), the user-facing messages follow from it ("A report covers up to 10 funds. You hold N, so generate it in two reports."; "Choose between 1 and 10 of the funds you hold."), the NAV2 tests are derived from the constant, and the production runbook, release plan and Stage 3 report carry the new number. Row 23 and the 20-fund timing in section B3 are unchanged as measurements; the 20-fund report is no longer something the application will generate, so the open item about 20 funds on DEV is closed by the decision rather than by a new measurement. The DEV timing table for 10 funds (cold in 2 calls, warm in 1 call, worst 22.1 s on that link) is now the relevant one. The two B2 DEV runs that used a choice of 20 predate the decision and are kept as evidence of selective hydration; a choice of 20 would now be refused with the 422 message. **Update 16-10-2026 (Product Owner decisions): D-6 is FIXED in this release (statement import keeps same-name different-ISIN sections as separate funds; see the D-6 paragraph) and the shared-code changes (`analyticsRepository.ts`, `userNavHistory.ts` `loadCoverage` in groups of ten, `components/admin/benchmarkData/ui.tsx`, the two test guards) ship in this release.** The release SHA is therefore the newest tip given in the hand-off message, not `b50c337`.

## 0. Identity

| Item | Value |
|---|---|
| Branch | `feat/nav2-release-candidate-20261014`, branched from `integrate/nav2-production-20261007` (tip `b1ec39a`) |
| RELEASE_SHA | The tip commit that adds this file (a commit cannot contain its own hash: it is given in the hand-off message and by `git rev-parse feat/nav2-release-candidate-20261014`). The last commit that changes anything outside documentation and evidence logs is the **code freeze `a8c6410`**. |
| origin/main at the last merge | `417d5f579815724dc22170667125ada5a261334c` (fetched 16-10-2026; it is an ancestor of the branch; merge commit `426ed95`). Earlier merges: `765b813` (for `1acb916`), `de71bad` (for `af2d330`), `fdba97d` (for `4b5a60a`). Migration numbers: NAV2 keeps 0260 to 0263, 0269 to 0271, 0281, 0282; main has 0272 to 0274 (resource bulk import) and 0285 (income tax amount); 0283 staff Premium, 0284 AIE cap and 0286 Module 11 prompt v3 are other workstreams'. `check:migrations` and `check:migrations:against-main` are clean. |
| Merge base with origin/main | `1acb916` at the first merge, then `af2d330` |
| Tree clean at freeze | Tracked files: clean after the commits (the full-suite runs rewrite checked-in files under `scripts/`; they were restored each time). Untracked: only the local `test-artifacts/` folder of this worktree. |
| Migration numbers | 0281 and 0282 are new and unique: a search of every commit on every local and remote branch (`git log --all`) for migrations 0281 to 0284 finds only these two files. No renumbering was needed. 0261 gained a precondition guard (below). |
| DEV project | `vqycarelcoijzwlpkpcz` (checked in every script that touches DEV; a `PRODUCTION_` variable makes the tools refuse to run) |

Commits on the branch since the integration branch: `c7ca057` (B1 to B5, migrations, DEV pack), `04ec3b6` (livelock guards, shallower reads, tooling), `5b424cd` (wrong-currency series fix, notice contrast, journey corrections), `de71bad` (merge of origin/main), `a8c6410` (two sibling-workstream test guards, baseline comparison, production README paragraph: the code freeze), then the documentation and evidence commit. Update of 16-10-2026: `fdba97d` (merge of origin/main `4b5a60a`), the D-6 fix commit (`schemeKeying.ts`, `documentProcessing.ts`, tests), `426ed95` (merge of origin/main `417d5f5`), then the fixes for two guards that main added (shared DataTable on the on-screen report table, the RBI reader listed as a cron-only building block) and the final documentation.

## 1. What changed in this release candidate (and why)

| # | Change | Where | Evidence |
|---|---|---|---|
| B1 | A corrected NAV can never be served from a stale cache entry. The cache key carries the checksum of the live NAV series, so freshness does not depend on the correction worker. Eight proofs, in order, with the worker never run until proof 7. | `lib/engines/nav2/cacheKeys.ts` (unchanged), `tests/unit/nav2/nav2ReleaseCandidateCorrectionFreshness.test.ts` | UNIT-TESTED with named negative controls (key without the series checksum: 4 tests fail); DEV-VERIFIED in journey 3 (28 pass, 0 fail) and 3b (17 pass, 0 fail) |
| B2 | Selected-fund gate: the price-history gate, the planner, the fetch kick and the legacy fetch take the funds the report covers; a person who holds more funds than one report covers and has not chosen is asked to choose, not made to wait. | `reportNavHistoryGate.ts`, `windowPlannerService.ts`, `nav2TriggerRunner.ts`, `fundAnalyticsReportService.ts` | UNIT-TESTED (30 held, 20 selected); DEV-VERIFIED with a real accepted statement (below) |
| B3 | One request clock (22 s) from the moment the request arrives, typed answers (201, 200 replay, 202 preparing or in steps, 503 timed_out, 500 failed, 409, 422), an `Idempotency-Key` header with a request fingerprint (migration 0281), no partial issued report, progress guarantee on a slow database, and reads reduced from 71 to 160 sequential round trips to a traced depth of 44 to 47 waves. | `fundAnalyticsReportService.ts`, `requestDeadline.ts`, `reportLimits.ts`, the route, the client, `analyticsRepository.ts`, `fundAnalyticsLoader.ts`, `userNavHistory.ts` | UNIT-TESTED; PGLITE-VERIFIED (0281); DEV-VERIFIED timings (B3 section) |
| B4 | Scheme resolution: an ISIN and an AMFI code that point at different instruments are refused and open one review case; the monitoring page shows the held-back count (migration 0282). | `schemeResolution.ts`, `0282_...sql` | UNIT-TESTED; DEV-VERIFIED in journey 5b (exactly one case, no transaction written on a guess, idempotent re-process); 0282 count on the monitoring page: DEV BLOCKED |
| B5 | Statements that said written RBI confirmation is legally required now carry the Product Owner wording (below). The weekly refresh switch stays OFF. | docs, `riskFreeUploadService.ts` attestation text, `switch_on_weekly_refresh.sql` | UNIT-TESTED (repository scan); DEV: switch OFF verified; dry run journey 9 (9 pass, 0 fail) |
| C | `0261` refuses to run (P0001, nothing changed) if the live `pc6_nav_row_is_candidate` is neither the 0219 nor the 0261 text. | `0261_...sql` first statement | PGLITE-VERIFIED; DEV identity check BLOCKED (pack file 02) |
| New | Two livelock guards found on DEV (below), a currency filter for the Performance series (D3), a readable warn notice (J8b). | see section 3 | UNIT-TESTED with named negative controls |

**RBI wording (B5), as the Product Owner gave it:** "Written RBI confirmation is not required by Product Owner decision. Historical manual loading and automated refresh are permitted subject to technical validation, attribution, monitoring and the documented accepted reuse risk." The weekly job stays OFF until the final-build dry run passes; on DEV it is OFF, and the dry run wrote nothing.

## 2. Phase A: integration and freeze

* Fetched, inventoried, merged `origin/main` twice (`1acb916`, then `af2d330`; the second brought documentation, scripts and tests of the planning-benchmarks first load only: no migrations, no NAV2 files). Conflicts in the first merge (admin `me` route and one admin test) were resolved by keeping both sides (risk-free capabilities and the entitlement override).
* Migration collision check: see section 0.
* `tsc --noEmit`: exit 0, no errors, on the merge commit `de71bad` (needs `NODE_OPTIONS=--max-old-space-size=8192`).

## 3. Defects found and fixed in this run (all with a failing-then-passing test)

| # | Defect | Severity | Found by | Fix |
|---|---|---|---|---|
| D-1 | **Planner livelock.** The NAV2 planner kept asking for a fetch that had already failed three times in a row, so a report that names such a fund could be held for ever; the price-history gate had already given up on the same fund. | P1 for a person whose source keeps failing for one fund | DEV, big holder, public source timing out | `planFetches` leaves a fund alone after `REPORT_NAV_MAX_FAILED_ATTEMPTS` failed fetches in a row; the report service no longer waits for a fund the gate has released (`giveUpIds`). Negative controls: guard removed gives a named failure in `nav2WindowPlanner` and `nav2FundAnalyticsService`. |
| D-2 | **Sequential read of the whole portfolio.** The shared analytics dataset read every held fund's prices in one query that pages 1,000 rows at a time; a person who holds 22 funds with 13 years of prices waited for about 75 pages in a row (18 s on the DEV link). A report for ONE fund cost as much as for 22 because the dataset is not scoped. | P1 for latency (the platform ends a request at 28 s) | DEV request trace | One read per fund, ten at a time, rows put back in (date, id) order (`analyticsRepository.ts`); the same for the NAV2 loader and the coverage lookup. 1 fund went from a 24 s timeout to a 13 s report on the same link. |
| D-3 | **A price in another currency moved the Performance total.** A synthetic AUD price ten times larger for an INR fund changed the Performance total from 188,960 to 852,065 while Holdings, Overview, Dashboard and Fund analytics did not move. | P2 (a wrong-currency row is a data error, but surfaces must agree) | D3 journey | The series builder leaves out a price whose currency differs from the instrument's own (a null currency is kept). Negative control: removing the filter fails `nav2ReleaseCandidateAnalyticsNav`. |
| D-4 | Warn notice title had a contrast of 3.27 to 1 on the Fund Analytics Health page (axe: serious). | P3 | Journey 8b | The warn title is ink; border and background still carry the tone (`components/admin/benchmarkData/ui.tsx`). Journey 8b: 43 pass, 0 fail. |
| D-5 | Planner and gate disagreed about "loaded": a report could show "18 of 20 funds ready" (the cap was 20 when this ran) for ever while the fetch kick did nothing because the per-person hourly fetch limit (30) was used up. | Documented limitation (not changed) | DEV | See Limitations. |

Harness faults found and fixed (not product defects): the big-holder script expected 30 funds although the statement's same-name sections merged into 22 instruments (D-6 below, now fixed), journeys 6b and 8 expected an earlier page plan, D3 and D5 had wrong paths or a syntax error, the dev inventory script printed "MISSING" for HTTP 206 answers.

**D-6 (CLOSED on 16-10-2026 by Product Owner decision; was: limitation, not fixed).** In the statement import (`documentProcessing.ts`), two scheme sections with the same normalised name, plan, option and AMC were merged into one scheme because the grouping key did not include the ISIN: the second fund's ISIN was dropped, its units were added to the first fund, and no review case was opened (seen on DEV: a 30-section statement became 22 instruments). **Fix:** the key is now built by `lib/services/investment-intelligence/schemeKeying.ts`. It stays `name|plan|option|amc` (so an ordinary statement is keyed and merged byte for byte as before, including the common case of an ISIN in the transaction section and none in the holdings section) and the ISIN joins the key only when the statement itself holds two different ISINs under one key (the AMFI code does the same when the ISINs do not disagree). A line that carries no identifier next to two different identifiers is never matched by name: it opens ONE `ambiguous_instrument` review case listing the funds it could be and creates no instrument. The decision depends only on the set of identifiers in the statement, so a re-process gives the same keys; plan and option stay in the key, so different plans never mix. **Evidence: UNIT-TESTED** (`nav2ReleaseCandidateSchemeKeying`, 15 tests; the old rule is shown to merge, the new rule to keep two funds; a named negative control with the ISIN rule disabled fails two of them) and **DEV-VERIFIED**: the same 30-section statement now ends on **30 distinct instruments** (30 positions, 30 holdings, 30 transactions, no case; before 22), a forced re-process changes nothing (the route answers that the document is already processed). Ordinary accepted statements: the existing import, parser, owner, joint-holding, resolution and statement suites (78 files, 1,282 tests) pass, DEV journeys were re-run on the fix (logs `docs/nav2/rc_evidence/d6_*.log`): journeys 1 and 2 54 of 54, journey 5b 6 of 6, journey 6 19 of 19, and journey 6b accepted its three joint-owned statements (200, 200, 200) and passed its import-dependent checks; its two other checks (the 3-year CAGR oracle) failed in one run only because the recent-price fixture rows had just been removed, and in the next run the joint-holdings report did not converge within 24 calls on the slow DEV link (the documented 22 second limit; the same journey passed 18 of 18 on the code freeze before this change), so journey 6b is not claimed as re-run on the D-6 code. The full-suite comparison is in `docs/nav2/BASELINE_FAILURES.md`.

## B2 on DEV (real accepted statement, real routes)

A fixture person (administrator fixture user) uploaded and accepted one 30-line statement through the real upload and process routes. The importer resolved it to **22 distinct funds** (D-6), all certified, no reconciliation case. Fetching was OFF while accepting: **0 history rows were stored for the funds without history** (held-only storage).

| Check | Result |
|---|---|
| Real gate over the real DEV tables, funds without history held | Unscoped the report is held; scoped to the 4 funds with history it is not (PASS) |
| A report for the 4 funds with history | 201 issued although 18 other funds have no history (PASS); no fetch was started for them: 0 rows (PASS) |
| 22 held and no choice | 409 `select_funds`, `heldFundCount` 22 (the harness expected 30 and was wrong; the product is right) |
| A fund the person does not own | 422 with the one plain sentence, nothing issued (PASS) |
| A choice of 20 (4 + 16) | Waited only for its own funds (`total` at most 20), fetched only those: the 16 chosen funds went from 0 to 7,402 rows, the unselected stayed at 0 (PASS). The public source (mfapi.in) timed out for many funds from this machine, so completion was by the planner's give-up rule (D-1) and, for timing, by loading the published series with `load_history_fixture.mjs` (marked rows, removed by the cleanup). |
| Manifest | The issued report pins the 20 chosen ids (sorted), `heldFundCount` 22, `max` 20 (PASS, read from report version 28) |

## B3 timings (DEV, from the development machine: 170 ms round trip, home link, other work on the same machine)

**These numbers are not production numbers.** A cold or warm generation is dominated by sequential database round trips and by transferring about 15 MB of price pages; production (Amplify to a database in the same region) is expected to be an order of magnitude faster, but that is an expectation, not a measurement. The engine alone: about 3 s cold and 1.2 s warm for 18 funds on the same machine (after memoising date parsing, from 13 s).

| Funds | Cold | Warm |
|---|---|---|
| 1 | 1 call, 15.2 s | 1 call, 12.2 s |
| 4 | 1 call, 15.1 s | 1 call, 15.6 s |
| 10 | 2 calls (in steps 14.7 s, then 22.1 s) | 1 call, 17.0 s |
| 20 | Did not converge in 20 calls: 3 in-steps answers (about 18 s), then 17 typed 503 timeouts at 22.2 to 23.9 s | 5 calls: four 503 timeouts, then issued at 21.8 s |

* No call ended in the platform's page in these runs: the longest typed answer was 23.9 s. Two earlier outliers (32.9 s and 64.7 s) happened while other processes (my own test runs and a dev recompile) were using the same CPU; they were not reproduced and are listed as an open risk.
* A person with 3 funds held jointly (ownership shares path, which loads the dataset twice) needed 5 calls of about 20 s each to get one report on this link.
* Work after a timed-out response keeps running on a long-lived development server (and writes the shared cache, which is what makes the next call faster). On Amplify the instance may be frozen after the response; this is unproven either way.
* **Pilot limit.** The mission rule is to lower the pilot limit if 20 cannot finish with margin. The DEV link cannot show 20 finishing with margin; 10 does finish. Recommendation was: pilot at no more than 10 funds per report, and measure on production at STOP GATE 2 before raising it to 20. **DECIDED by the Product Owner on 15-10-2026: the pilot limit is 10 funds per report.** `FUND_ANALYTICS_MAX_FUNDS` in `lib/config/nav2/reportLimits.ts` is now 10, and `nav2ReportFundCap` and `nav2ReleaseCandidateSelectedFunds` are written against that constant. The 20-fund measurements above stay as measured; they are the reason for the decision. The pairwise-correlation limit of the engine (`MAX_SCHEMES_FOR_PAIRS`, 20) is a separate engine limit and did not change.

## Phase C: DEV catalog, migration idempotency, retention protection

| Item | Result | Label |
|---|---|---|
| NAV2 objects present on DEV by REST (13 tables, 136 columns, 13 functions) | Only three differences: the two 0281 columns and the 0282 function, which are expected until the Product Owner applies 0281 and 0282 | DEV-VERIFIED (REST level) |
| Constraints, indexes, policies, grants, triggers, function bodies on DEV | Needs `sql/03_catalog_inventory.sql` run by the Product Owner and compared with `docs/nav2/dev_inventory/expected_inventory.json` | **BLOCKED on PO-applied SQL** |
| Replaying all NAV2 migrations: from empty, from the historic partial 0260 state, from complete, and a second run | Identical inventory in all four states (136 columns, 154 constraints, 29 indexes, 18 functions); deploy-order proof 108 of 108 | PGLITE-VERIFIED |
| Retention function `pc6_nav_row_is_candidate` | 0261 now starts with a guard comparing the normalised md5 of the live text with 0219 (`f76a895d...`) and 0261 (`f5721ba0...`) and refuses otherwise (P0001, nothing changed). Identity, owner, arguments, grants and behaviour on DEV: pack files 02, 02b, 02d | PGLITE-VERIFIED; DEV **BLOCKED on PO-run SQL** (the function exists on DEV, HTTP 200) |
| Job switches on DEV at the start and now | `nav2_fund_analytics` ON (earlier PO decision for DEV); `nav2_trigger_planner`, `nav2_correction_worker`, `nav2_risk_free_weekly_refresh`, `pc6_selective_historical_hydration` OFF. The weekly refresh was already OFF; nothing to turn off. | DEV-VERIFIED |

## Evidence provenance

The DEV journeys of Phase D were all re-run in one chain on the code freeze: the working tree equal to commit `a8c6410` in `lib`, `app`, `components` and `supabase` (a diff of those four folders between `5b424cd` and the freeze is empty). The B3 timings and the 30-line big-holder run were taken on `04ec3b6`, which differs from the freeze only by the wrong-currency filter and the notice colour. Raw logs of every run quoted here are in `docs/nav2/rc_evidence/` (journey logs 1 to 9, D3, D5, D8, the big-holder logs, the timing table, the oracle output, the NAV2 test run). The full-suite JSON files are not committed (about 6 MB each).

## Phase D

| D | What | Result |
|---|---|---|
| D1 | Accepted-statement journey: holder (3 funds incl. one redeemed): upload, parse, accept, held-only fetch, report | 54 pass, 0 fail (journeys 1 and 2); at scale: the 30-line statement above |
| D2 | Premium and tenancy matrix: free user 403, no data leak across users, entitlement edge cases, risk-free admin split (upload-only cannot switch, switch-only cannot upload) | Journey 5 part 1: 41 pass; part 2: 6 pass; D5 extra rows: pass |
| D3 | Financial reconciliation: Holdings, Performance, Overview, Investments, Dashboard, Fund analytics vs an independent units x latest eligible NAV; future-dated and wrong-currency prices; manual investments byte-identical | 21 pass, 0 fail after D-3 (before the fix: 1 fail, the Performance total) |
| D4 | Independent oracle (Python, Decimal arithmetic, imports nothing from the repository) on report version 27 of the holder, 3 funds | 159 pass, 0 fail; negative control (one NAV changed by 0.1 percent): named failures in rolling returns and others |
| D5 | Immutability: an issued report is byte-identical after a NAV correction (journey 3), a risk-free value correction (3b), a new daily NAV, a transaction correction, the series switched OFF and back ON | Journey 3: 28 pass; 3b: 17 pass; D5 extra: 15 pass, 0 fail. Metric-definition change and a later benchmark series: unit-tested only |
| D6 | PDF: real Chromium rendering, 5 pages for 3 funds, no image-only pages, minimum font 7.1 pt, charts present, dates day-first, footer page numbers; phone width and keyboard path; axe | Journey 8a: 24 pass; 8b: 43 pass, 0 fail after D-4. Page 1 and 2 were also looked at as images |
| D7 | Weekly RBI fetcher dry run on the final build | Journey 9: 9 pass, 0 fail; wrote nothing; weekly switch OFF |
| D8 | Concurrency and fairness: six simultaneous requests, two users at once, a repeated accepted-statement event | Fairness, one-fund choice, repeated event: pass. **One key, one report under concurrency: BLOCKED on 0281 on DEV** (journey 7 stored 15 new reports and D8 8 for 6 intended: with the column absent the server logs a warning and issues without a key, so every retry after a typed answer can issue another report. This is why 0281 must be on the database BEFORE the code is switched on; PGlite and unit tests prove the key) |
| D9 | Fixture cleanup | **Done on DEV at 19:36 UTC on 14-10-2026 with the prepared script `scripts/nav2_rc/cleanup_rc.mjs` (dry run first, then `--apply`; children before parents; every target re-queried).** Attempted, committed and remaining:

| Target | Attempted | Committed | Remaining |
|---|---|---|---|
| Fixture users: source documents, accounts, transactions, holding snapshots, truth status, reconciliation cases, publications | 7, 10, 28, 9, 9, 1, 1 | the same | 0 |
| Fixture users: Fund analytics reports (the pins and render tokens go with them) | 112 | 112 | 0 |
| Household members and business entities created during the run | 6 and 3 | 6 and 3 | 0 |
| Price rows carrying the marker `NAV2RC_FIXTURE` (history fixture, recent-NAV fixture, D3 exclusion rows) | 42,033 | 42,033 | 0 |
| History rows fetched during the run for the 26 funds that had none (the application's own hydration; the count of 49,367 includes the 41,965 marked rows already removed above, so the rest is 7,402) | 49,367 | 7,402 | 0 |
| Hydration attempt rows of those funds | 12 | 12 | 0 |
| Shared cache entries created during the run (derived, recomputable) | 28 | 28 | 0 |

Also done: the four NAV2 job switches and the hydration switch put back to OFF (`nav2_fund_analytics` is ON, as the Product Owner left it on DEV), country confirmation and plan of the five fixture users restored, the temporary cron secret file deleted, the dev server stopped.

**Deliberately left:** the append-only audit events, the correction ledger (`nav2_correction_events`: 46 rows, 8 more than before, written by the correction journeys), the users' own earlier manual investments, and the NAV2 objects themselves. `sql/30_fixture_residue_readonly.sql` in the DEV pack is the Product Owner's read-only confirmation (all zero except audit events and manual investments).

Temporary working copies outside the repository (the build copy and the baseline extract of origin/main) were deleted. |
| D10 | The 30-row table | below |

## E: code and build verification

| Check | Result |
|---|---|
| `tsc --noEmit` (whole project, `--max-old-space-size=8192`) | exit 0, no errors, on the merge commit `de71bad` and again on the code freeze `a8c6410` |
| ESLint on the 230 JavaScript and TypeScript files changed against origin/main | 0 findings in NAV2 files. One pre-existing error in `components/ui/AppShell.tsx` (react-hooks/set-state-in-effect at `setMobileOpen(false)`, the same line exists on origin/main at line 143) and two `<img>` warnings in the same file. Not touched here. |
| All NAV2 tests together (`tests/unit/nav2`, 59 files) plus the two migration-number guards of other workstreams | 61 files, 948 tests, all pass. Failing-then-passing negative controls were run by hand for: planner livelock guard, service give-up guard, idempotency replay, series checksum in the cache key, wrong-currency filter (each gave a named failure and was reverted). |
| Environment-sensitive suites, run singly | The 25 suites that the full run lost to the vitest `ssr` ENOENT fault, re-run together with two workers: 1,153 of 1,153 pass. The other persistent failures are identical on origin/main (table below). |
| Full unit suite, release candidate against a clean extract of origin/main `af2d330` | Baseline: 13,103 tests, 38 failures (37 files). Release candidate: 13,664 tests, 27 failures (36 files). Only 4 entries failed on the branch alone: two were real numbering assumptions in other workstreams' tests (fixed, see `docs/nav2/BASELINE_FAILURES.md`) and two were the random ENOENT harness fault. Everything else that fails fails the same way on main. |
| Clean production-style build | `next build` (Next.js 16.2.12, Turbopack) from `git archive` of the branch into an empty folder with a real copy of `node_modules` and placeholder public variables: compiled in 84 s, type check 2.8 min, exit 0, no warnings. 605 route lines. The NAV2 routes are all present and dynamic: `/reports/fund-analytics`, `/reports/fund-analytics/print`, `/api/reports/fund-analytics` (and `[id]`, `[id]/export`), `/admin/investment-intelligence/nav2-monitoring` with its API, and the two cron routes. |
| Build size | `.next` 156 MB (server 148 MB, static assets 5.6 MB). Not compared with the Amplify artifact limit here: that measurement belongs to the production phase. |
| Scripts rewritten by the full run | `git checkout -- scripts/` after each full run (the known hazard); `git status` shows no tracked change outside the commits. |

## D10: the 30-row certification table

Classes: PASS, CONDITIONAL PASS, FAIL, BLOCKED, NOT STARTED, NOT APPLICABLE. Evidence labels: UNIT-TESTED, PGLITE-VERIFIED, DEV-VERIFIED, PRODUCTION-VERIFIED, DEPLOYED BUT OFF, PILOT-LIVE, BLOCKED, NOT STARTED, NOT APPLICABLE. Nothing here is PRODUCTION-VERIFIED, DEPLOYED BUT OFF or PILOT-LIVE.

| # | Item | Class | Evidence and what is missing |
|---|---|---|---|
| 1 | Scheme resolution | CONDITIONAL PASS | ISIN against AMFI conflict is refused and opens one review case: UNIT-TESTED, DEV-VERIFIED (journey 5b: exactly one case, no transaction on a guess, idempotent re-process). The held-back count on the monitoring page needs 0282 (BLOCKED). D-6 (same-name sections merged) is FIXED and DEV-VERIFIED on 16-10-2026: 30 sections now give 30 instruments. |
| 2 | Held-only trigger | PASS | DEV-VERIFIED: accepting a 30-line statement with fetching OFF stored 0 history rows; a choice of 20 fetched only its own funds and left the unselected funds at 0 rows; UNIT-TESTED. |
| 3 | Window precision | PASS | UNIT-TESTED; DEV-VERIFIED journey 2 (repeated planner calls: same windows, nothing written). |
| 4 | Provider fidelity and corrections | PASS | Eight B1 proofs UNIT-TESTED with named negative controls; DEV-VERIFIED journeys 3 (28 of 28) and 3b (17 of 17). |
| 5 | Absolute and CAGR returns | PASS | DEV-VERIFIED against the independent oracle (159 of 159, negative control red). |
| 6 | Rolling and point-to-point returns | PASS | Same oracle run (1M to 5Y rolling windows, point-to-point). |
| 7 | Daily and log returns | PASS | Same oracle run. |
| 8 | Volatility | PASS | Same oracle run. |
| 9 | Sharpe and Sortino | PASS | Same oracle run with the RBI series; typed risk_free_missing state DEV-VERIFIED on two funds with the series OFF, back to computed or short-of-history with it ON (D5). |
| 10 | Maximum drawdown | PASS | Same oracle run. |
| 11 | Beta and alpha | NOT APPLICABLE | **NOT ACTIVATED — LICENSED BENCHMARK DATA UNAVAILABLE; fail-closed UI verified.** The PDF and the screen say Beta and alpha: not available yet (no benchmark index is linked to this fund); journey 8a and 8b pass. This is not a calculation pass with real data. |
| 12 | SMA, EMA, ROC | PASS | Same oracle run. |
| 13 | Held-scheme ranking and comparability | PASS | Same oracle run (ranking checks); PDF page 5 Comparing your funds viewed. |
| 14 | Held-scheme correlations | PASS | Same oracle run (all pairs); the engine limit for pairs is 20 funds and a report now covers at most 10, so every report has its pair table. |
| 15 | High, low, mean, median | PASS | Same oracle run; the NAV-level footnote (c) is on every cell. |
| 16 | XIRR separation and correctness | PASS | Your own return (XIRR) is shown apart from the fund's growth (CAGR); journey 6b: a joint holding at the user's share has the whole-holding XIRR (flows proportional), 18 of 18. |
| 17 | Value and NAV consistency | PASS | DEV-VERIFIED D3: Holdings, Performance, Overview, Investments, Dashboard and Fund analytics agree with units times the latest eligible NAV (21 of 21) after the wrong-currency fix (D-3). |
| 18 | Joint, entity, manual, redeemed handling | PASS | Journeys 6 (19 of 19) and 6b (18 of 18); redeemed holding exactly zero; manual investments byte-identical (D3). |
| 19 | Historical and finalized-report immutability | PASS | DEV-VERIFIED D5 (15 of 15), journeys 3 and 3b; a metric-definition change and a later benchmark series are UNIT-TESTED only. |
| 20 | Benchmark and risk-free governance | CONDITIONAL PASS | Risk-free upload, switch, correction and the permission split are DEV-VERIFIED (journeys 3b, 5, D5); RBI wording is the Product Owner's; weekly job OFF. Benchmarks are not activated (row 11). DEV catalog for policies and grants is BLOCKED. |
| 21 | Unavailable states | PASS | Typed states for short history, missing risk-free, no benchmark; never a zero; seen on the PDF and the screen (journeys 8a, 8b). |
| 22 | Cache, versioning, idempotency | CONDITIONAL PASS | Cache key with the series checksum UNIT-TESTED with negative controls; DEV journey 4 shows 13 pass and 2 fail only because the Product Owner's report version 6 no longer exists on DEV (precondition, not a defect). The Idempotency-Key is UNIT-TESTED and PGLITE-VERIFIED; its DEV proof is **BLOCKED on migration 0281**. |
| 23 | Concurrency, resumability, fairness | CONDITIONAL PASS | Fairness, one-fund choice, repeated accepted-statement event, resumability in steps: DEV-VERIFIED. One key, one report under six simultaneous requests: BLOCKED on 0281. 20 funds did not finish on the DEV link (B3); the Product Owner set the pilot limit to 10 funds per report on 15-10-2026 and the code now says 10. |
| 24 | RLS, privacy, audit | CONDITIONAL PASS | Cross-user, free-user and anonymous behaviour DEV-VERIFIED (journeys 5 and 5b: 47 of 47). Policy and grant inventory from the catalog is BLOCKED. |
| 25 | UI, accessibility, mobile, PDF | PASS | Journey 8a 24 of 24, 8b 43 of 43 (axe, 375 px, keyboard); the PDF was rendered by Chromium and pages 1 and 2 were looked at as images (day-first dates, charts present, no image-only pages, smallest text 7.1 pt). |
| 26 | Storage and non-held-history controls | CONDITIONAL PASS | Held-only storage and selective hydration DEV-VERIFIED (row 2). The retention function identity and behaviour on DEV need the pack files 02, 02b and 02d (BLOCKED); the 0261 guard is PGLITE-VERIFIED. |
| 27 | DEV accepted-statement journey | PASS | Journeys 1 and 2: 54 of 54; the 30-line statement (22 funds) accepted through the real routes, certified, no case. |
| 28 | Production deployment and pilot evidence | NOT STARTED | Phases F to K were out of scope. |
| 29 | Rollback and recovery readiness | CONDITIONAL PASS | Rollback files for 0281 and 0282 (DEV pack 90 and 91, production pack) are PGLITE-VERIFIED; never run on DEV or production. Production has no managed backups on the Free plan (Product Owner memo 08-10-2026); manual table backups are part of STOP GATE 1. |
| 30 | Remaining PO decisions | CONDITIONAL PASS | Listed in the next section: apply the DEV pack; (pilot limit: decided, 10); D-6 (decided and fixed 16-10-2026); the shared-code changes (decided: they ship in this release); the 30 per hour fetch limit for first reports. |

## Limitations and open items

**Limitations (honest list)**

1. **20 funds are not shown to finish on DEV** from this machine (B3). **Decided by the Product Owner on 15-10-2026: the pilot limit is 10 funds per report, and the code (`FUND_ANALYTICS_MAX_FUNDS`) and the tests, messages and runbook now say 10.** Production timing is unmeasured: the first production measurement is a STOP GATE 2 item, and raising the limit needs it.
2. **One call can take as long as the whole 22 s budget even for one fund on a slow link** (a report is about 45 sequential database round trips deep). On a link like DEV's the per-call time is dominated by those trips, not by calculation. Not an issue on a fast network, but the margin there is unproven.
3. **Work after a timed-out response.** On the development server it continues and fills the cache; on Amplify it may be frozen. The next call resumes from whatever was cached either way. One outlier call of 32.9 s and one of 64.7 s were seen under heavy local CPU contention and not reproduced.
4. **Fund history for a first report is fetched through the public source and is limited to 30 fund fetches per person per hour** (`USER_NAV_FETCH_MAX_PER_HOUR`). A person whose first report needs history for more than about 15 funds waits for the next hour for the rest; the report keeps saying it is being prepared. Normally the history is fetched when the statement is accepted, before the first report, but only for the funds with a requirement.
5. **The public source timed out for many funds** from this machine (about 50 percent of fetches); the planner and the gate now stop waiting for a fund after 3 failed fetches in a row, and the report says that fund's longer history is not available.
6. **D-6 closed** (16-10-2026, Product Owner decision): same-name sections with different ISINs stay separate funds and a line without an identifier next to them opens one review case; see the D-6 paragraph. One behaviour to know: when a statement holds such a pair, its summary-of-holdings lines (which print no ISIN) cannot be assigned to either fund, so they open ONE review case per such fund name until the person chooses; the transactions are matched by ISIN as usual.
7. **Shared code was changed and SHIPS IN THIS RELEASE (Product Owner decision 16-10-2026)** (outside NAV2 files, behaviour preserving except D-3 and D-6): `analyticsRepository.ts` (per-fund price reads, currency filter), `userNavHistory.ts` (`loadCoverage` in groups of ten), `components/admin/benchmarkData/ui.tsx` (warn title colour), and two migration-number guards in other workstreams' tests. They are covered by the existing suites (all pass) and the new NAV2 tests.
8. **Idempotency under concurrency on DEV** needs 0281; **the held-back statement-line count** needs 0282; **catalog and retention identity** need the pack. Until the Product Owner runs the pack these stay PGlite and unit only.
9. **Date-dependent tests** (`promoHardeningProofCorePglite`, `iiNetWorthNavRemarkPublishFlow`) fail on main as well when run at these times; not touched.
10. Beta, alpha and every benchmark comparison are NOT ACTIVATED (no licensed data).

**Conflicts between instructions or documents, and how they were resolved**

* The mission says to lower the pilot limit if 20 cannot finish, while the recorded Product Owner decision (07-10-2026) fixed 20 funds per report. First resolved by keeping 20 in code and recommending 10; the Product Owner then decided 10 on 15-10-2026 and the code was changed (commit after the tip first reported).
* The production README said the gate and planner look at all funds held; B2 changed that and the README now says so (the old sentence was wrong after this release candidate).
* Two tests of other workstreams assumed they were the highest-numbered migration or that NAV2 was absent; they were corrected (see `BASELINE_FAILURES.md`).

**Decisions for the Product Owner**

1. Run the DEV pack (`docs/nav2/po_apply_dev_release_candidate/`), in the order of its README, and send back the rows; the agent then closes rows 1, 22, 23, 24, 26 and 29 or reports the difference.
2. Pilot limit: DECIDED 15-10-2026, 10 funds per report (done in code and tests).
3. D-6: DECIDED 16-10-2026 to fix it in this release (done, see above).
4. Shared-code changes (item 7): DECIDED 16-10-2026, they ship in this release.
5. The hourly history-fetch limit (30) for a first report of many funds.


## What STOP GATE 1 (production pack) would need

Nothing below was started. It is the list of what the production hand-over must contain, given what this DEV run found.

1. The production pack (`docs/nav2/po_apply_production/`) already holds the nine migrations (0260 to 0263, 0269 to 0271, 0281, 0282), prechecks P3, P3c, P3d, rollbacks, the final inventory file with 17 functions and the README. Re-check its migration copies against the branch at the RELEASE_SHA (the byte-identity test `nav2ProductionHandoverPack` does this).
2. **Backups first:** production has no managed backups on the Free plan; a manual table backup of the tables the NAV2 migrations touch (`admin_users`, `ii_prices_nav` window used by the retention function, job control rows) before any DDL.
3. Precheck P3: the live `pc6_nav_row_is_candidate` must be the 0219 text (the 0261 guard refuses otherwise).
4. Order: database first, then the code, then the switches, each switch one at a time, `nav2_fund_analytics` last. Weekly RBI refresh stays OFF until the final-build dry run is repeated on production-like data.
5. Smoke test for the pilot: one Premium account, 1, 4 and 10 funds, a timing table with the same columns as B3 (this is the first real measurement of production time), a PDF export, a free account refused, and the monitoring page.
6. Decision at STOP GATE 2: whether the timing table supports raising the pilot limit above 10 (it is 10 by Product Owner decision of 15-10-2026).
7. Rollback: 0281 and 0282 rollbacks (issued reports are not touched), switches OFF, and the previous Amplify build.
8. Fixture removal on DEV is done by the cleanup script below; production has no fixtures to remove.

