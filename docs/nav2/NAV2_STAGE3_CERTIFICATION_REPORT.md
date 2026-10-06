# NAV2 Stage 3 - DEV certification report (06-10-2026)

Verdict: **CONDITIONAL PASS. NAV2 USER-HELD ANALYTICS - FULL PASS is NOT claimed.**
Benchmark metrics (beta, alpha, benchmark returns): **NOT ACTIVATED - LICENSED DATA UNAVAILABLE.** They show as typed "unavailable" states, never as zero.

This report reconciles the 30 rows of the section 22 certification table (`docs/nav2/NAV2_TEST_MATRIX_AND_STAGE_PLAN.md`, section 3) with what the Stage 3 journeys on DEV proved, row by row, and says plainly where a row is still conditional and why.

## 1. What was run, on what

| Item | Value |
|---|---|
| Database | DEV only (project `vqycarelcoijzwlpkpcz`, host checked by the harness before every call). Production untouched. Nothing pushed. |
| App | this worktree, `next dev --webpack` on port 3981 (never port 3971), `.env.local` with the DEV variables only, `CRON_SECRET` set to a throw-away local value for the cron-route checks |
| Code under test | `d0708e2` (the frozen commit) plus the six fix commits listed in section 4. **Current HEAD is stated in the final line of section 4.** |
| Users | existing standing fixture users (`forecast.tc053`, `tc058`, `tc065`, `tc072`, `tc078`, all `@example.test`), sessions minted by the repo harness (`scripts/canonical_cert/lib/session.mjs`: no password, no account created). Country confirmed and Premium granted to four of them for the run; the original rows are saved and `node scripts/nav2_stage3/setup.mjs revert` puts them back. |
| PO account | read only. The PO's seed holdings, their report versions 1 to 6 and the PO's browser session were not touched. Version 6 is byte-identical before and after (hash recorded at the start and end of journey 4). |
| Statements | synthetic genuine-format CAMS statements built by `scripts/nav2_stage3/build_statements.ts`: every NAV on a transaction date is AMFI's published NAV for that date; investor, PAN (never-real PCQAL prefix), folios and references are synthetic. Parsed by the real parser, uploaded through the real route, owner chosen before upload. No seed insert. |
| Switches | `nav2_trigger_planner`, `nav2_correction_worker`, `nav2_risk_free_weekly_refresh` and `pc6_selective_historical_hydration` were each armed only inside the journey that needed them, restored in a `finally`, and read back OFF at the end (`logs/flags_end.log`). |
| Evidence | `test-artifacts/nav2_stage3/` (not committed: contains session-bound files): one log per journey in `logs/`, JSON evidence per journey, PDFs and their page PNGs in `pdf/`, browser screenshots in `ui/`. The scripts are committed under `scripts/nav2_stage3/`. |

Oracle: `scripts/nav2_stage3/oracle.mjs` re-derives value, gain or loss, XIRR and the 1, 3 and 5 year absolute return and CAGR from the raw DEV rows (transactions and NAV series) with its own code; it imports nothing from `lib/engines/nav2`.

## 2. Journey results

Counts are checks in the journey logs (`PASS` / `FAIL` lines). A FAIL listed here is a finding, not a script error.

| Journey | What | PASS | FAIL | The FAIL lines (findings) |
|---|---|---|---|---|
| 1 and 2 | Accepted-statement journey and held-only storage proof (upload, parse, review, accept, canonical holding, planner, NAV window, analytics, report, PDF; re-upload, repeated acceptance, publish, republish, repeated planner calls) | 54 | 0 | none |
| 2b | Live held-only fetch (the planner fetches, only for the held fund; before and after counts) | 19 | 0 | clean run on 05-10-2026 22:38 (E had 14 stored prices); the fund is now loaded, so the script cannot be repeated as is |
| 3 | NAV correction (controlled +2% on one price of fund E, worker, immutability, revert) | 28 | 0 | none |
| 3b | RBI observation correction (repo series: nothing invalidated; T-bill series: only dependents; report immutable; revert; the PO reports untouched) | 16 | 0 | none |
| 4 | Version-7 cache proof (new key format, not reusing earlier bundles, one-year rule, oracle, Version 6 unchanged) | 15 | 0 | none |
| 5 | Cross-tenant, direct access, admin and monitoring, cron routes, Premium loss | 39 | 2 | after 0269 and 0270 were applied to DEV (re-run 06-10-2026): MONITORING for the capability holder still 500 (statement timeout 57014), and the check that depends on it. The Premium-lapsed direct read now PASSES (was FAIL before 0269; first pass 38 PASS, 3 FAIL) |
| 5 part 2 | Wrong ISIN/AMFI pair, typed states, beta/alpha | 10 | 0 | none |
| 6 | Ownership and valuation cases (self, spouse, joint, trust, HUF, company, manual, redeemed) | 19 | 0 | none |
| 7 | Concurrency (6 simultaneous generations, 5 simultaneous worker runs, retry) | 15 | 0 | none |
| 8a | Final PDF acceptance (3 PDFs) | 36 | 1 | short-history-unavailable: NO BLANK PAGES, no page more than 30% empty below its content, no heading stranded at a page end, no text past the margin,  |
| 8b | Phone width, keyboard, semantics, axe-core (report page and both admin pages, 1280 and 375 px) | 40 | 3 | report-1280: axe-core finds no serious or critical violation (aria-required-children(1), aria-required-parent(5), listitem(5)); admin-monitoring-1280: KEYBOARD: Tab reaches the interactive controls in order and every stop shows a visible focus indicator (0 stops; without indica; admin-monitoring-1280: axe-core finds no serious or critical violation (color-contrast(1)) |
| 9 | Final-build RBI dry run against the live RBI site | 9 | 0 | none |

Notes on the table:

- Two passes. Pass 1 ran every journey in order on the final code; pass 2 re-ran journeys 5 part 2, 8a and 1+2 after script corrections and added 3b. The logs of pass 1 are kept as `*_pass1.log`. Script corrections were all to the SCRIPTS (a precondition that no longer held, a regex on wrapped PDF text, a user that by then held funds, a UTC date that rolled over mid-run), never to a threshold.
- Journey 2b cannot be repeated as is, because fund E is now loaded. Re-running it (pass 1) gave 17 PASS and 2 FAIL, and both FAILs are the proof that a second holder finds the history already stored: the plan was empty (`[]`) and the row count did not grow (1,613 to 1,613). The clean run is quoted from `j2b_clean_run_evidence.log`.
- Journey 5: first pass 38 PASS and 3 FAIL (monitoring timeout, the check that needs the monitoring page, Premium-lapsed direct read). After the PO applied 0269 and 0270 to DEV the journey was re-run: **39 PASS, 2 FAIL**. The Premium-lapsed direct read is now closed (0269 proven on DEV by behaviour). The monitoring snapshot STILL times out for an administrator (57014) even with 0270, because one exact count of the 3.1M-row price table alone takes about 3.7 s on DEV; migration 0271 (row estimate, labelled approximate) is written with a test and NOT applied.
- Journey 8a: the one FAIL is the layout judge's 30% limit on the cover page of a ONE-fund report (33% empty below its content; the page is short, not blank, and reads well). It is the judge's threshold edge, not a layout fault; the other two reports (three funds, two funds) pass the judge with no failure.
- Journey 8b: the three FAILs are not NAV2: the shared sidebar Reports menu ARIA, and the monitoring page in its error state (shared error message contrast, no controls to Tab to). Task chips were raised. After the two NAV2 fixes the report page has no serious or critical axe violation at 375 px, and at 1280 px only the shared sidebar findings remain.

## 3. The 30 certification rows

Status words: PASS = proven on DEV in this pass; PASS (unit) = proven only by the named unit or PGlite tests, not repeated on DEV in this pass; CONDITIONAL = the part that could be proven is proven and the missing part is named; NOT ACTIVATED = deliberately off; NOT STARTED = later stage. "Seed oracle" = the earlier Stage 3 pass of 05-10-2026 on the PO's seed holdings, whose numbers matched the independent oracle; it was not repeated here.

| # | Item | Verdict | Evidence and what is still open |
|---|---|---|---|
| 1 | Canonical scheme resolution | **PASS** | Journey 1: all 22 canonical transactions equal their statement lines (instrument, date, units, amount) for three funds (the first attempt parsed 20 of 22 because my own statement builder lost the last lines of a long one-page PDF; the builder now pages it, the application was right). Journey 5 part 2: an ISIN of fund A with the AMFI code of fund D opens exactly ONE `ambiguous_instrument` case for two statement lines, no transaction is stored on the guess, processing the document again opens no second case. Open DATA finding (not NAV2 code): seven DEV instruments carry the name of one fund and the AMFI code of another (found in the seed discovery), and the older NAV1 P4 fixture resolves PPFAS code 122639 to an instrument named "Mirae Asset Large Cap" on DEV. A data repair is needed before such a statement is trusted on DEV. |
| 2 | User-held-only hydration trigger | **PASS** | Journey 2b (clean run, fund E had 14 stored prices): before acceptance no requirement and no fetch; after acceptance exactly one window, for E, and a planned fetch for E only; the fetch loaded 1,599 prices for E; the global price count rose by exactly 1,599; A, B, C, D and six control funds gained or lost no row, no hold, no attempt; no instrument or scheme was added. Journey 1/2: with history already stored the plan holds one window per accepted scheme (3) and fetches nothing; the unheld fund D is never planned. Defect found and fixed: with the planner on and the NAV fetch switch off the report was held forever (0541731). |
| 3 | Required-window precision | **CONDITIONAL** | Windows are driven by each scheme's own earliest transaction (asserted against the statement) and by the policy buffers (E: from 10-02-2020 for a first purchase on 10-03-2025, the 5-year rolling endpoint). A bounded fetch was resumed in chunks and finished. The NAV1 inception-policy conflict is still an open PO decision. |
| 4 | Provider fidelity and correction handling | **CONDITIONAL** | Correction handling PASS (journey 3, below). Provider fidelity: 1,597 of the 1,599 prices loaded for E equal the values mfapi.in serves for AMFI's series; two deviations are listed in `provider_fidelity.json` (25-09-2025 is absent from mfapi.in, 12-03-2026 is 2111.779 stored against 2111.846 at mfapi.in). This compares two routes to the same data; it does not say which is right. |
| 5 | Absolute / CAGR returns | **PASS** (numbers) | Oracle: 1, 3 and 5 year absolute return and CAGR equal to 1e-9 for every fund in journeys 1 and 4, including the one-year rule on the requested window (363 actual days, requested 365, CAGR shown, disclosure printed). The convention difference with the Performance tab is shown on screen and in the PDF and tested unchanged; the PO decision to align or keep it is still open. |
| 6 | Rolling / point-to-point returns | **PASS** (point-to-point) | Point-to-point proven on DEV against the oracle. Rolling windows: PASS (unit) plus the seed oracle. |
| 7 | Daily / log returns | **PASS** (unit) | Not compared with an oracle on DEV in this pass. |
| 8 | Volatility | **PASS** (unit) | Seed oracle matched on 05-10-2026; not repeated here. |
| 9 | Sharpe / Sortino | **CONDITIONAL** | Computed on DEV with the RBI 91-day series, named in words everywhere (journey 8a); no independent Sharpe oracle was run in this pass. RBI's missing reuse licence is a PO-accepted risk, not a confirmation. |
| 10 | Maximum drawdown | **PASS** (unit) | Seed oracle matched on 05-10-2026; not repeated here. |
| 11 | Beta / alpha | **NOT ACTIVATED - LICENSED DATA UNAVAILABLE** | On DEV every beta and alpha is a typed label ("Benchmark mapping missing" or "Insufficient history"), never zero and never a number, in the API, the page and the PDF (journeys 1, 5 part 2, 8a). |
| 12 | SMA / EMA / ROC | **PASS** (unit) | |
| 13 | User-held rankings / comparability | **PASS** (unit) | DEV: the redeemed fund is excluded from the ranking (journey 1). |
| 14 | User-held correlations | **PASS** (unit) | Present in the DEV reports and PDFs; no DEV oracle. |
| 15 | High / low / mean / median | **PASS** (unit) | |
| 16 | XIRR separation and correctness | **PASS** | Oracle bisection equals the report to 1e-6 for every fund in journeys 1 and 4 (including the redeemed fund and a fund held under a year). |
| 17 | Current value / current NAV consistency | **CONDITIONAL** | The report value equals units x latest NAV from the independent sum on DEV (journeys 1, 3, 4, 6, to the cent). Agreement with Dashboard, Holdings, Investments and Performance for the same timestamp was NOT compared in this pass. |
| 18 | Joint / entity / manual / redeemed handling | **PASS** (mechanics), one question open | Journey 6: a Self and a Spouse folio of one fund are one scheme with the summed units; a joint 50/50 folio is in the personal report; Trust, HUF and Company folios are excluded and counted (`entityHeldSchemesExcluded`); a manual register entry never appears; a fully redeemed fund shows value 0, "fully redeemed". OPEN for the PO: the joint 50/50 folio is valued at the FULL account value in the report, not at the 50% share. |
| 19 | Historical and finalised-report immutability | **PASS** | An update of an issued report (count or content) is refused by the database trigger even for the service role; the baseline report is byte-identical after a NAV correction and after the worker ran (journey 3); the PO's Version 6 hash is unchanged (journey 4); a user cannot update or delete a report through the API's grants (journey 5). |
| 20 | BENCH-1 / risk-free governance | **CONDITIONAL** | Non-admins are refused (403) on the monitoring, risk-free status, upload and series-switch routes and the monitoring RPC (42501); the monitoring capability does not open risk-free upload or switch (journey 5). The weekly refresh dry run against the live RBI site: switch off makes no request; on, dry run by default, one page and one robots request, robots.txt unavailable then continued (option A), nothing written (before and after counts equal); the repo-rate reading (5.25 for the week ended 25-09-2026) equals the stored rate; the T-bill release search through the month-archive request, never run live before, found the 30-09-2026 release and its 5.5199 equals the stored value (journey 9). Still open: RBI reuse licence (PO-accepted risk); no re-authentication step, no preview before a series switch, no dual control (`CAPABILITY_SEGREGATION.md`). |
| 21 | Data-quality / unavailable states | **CONDITIONAL** | On DEV: "no funds" for a household whose only statement awaits reconciliation; "preparing" (202) while the planned history loads and then the report; insufficient history shown as typed states with a reason code and a sentence, never a number: 27 states (`window_not_covered`, "Price history for this scheme starts on 05-08-2026, after the requested start of 10-03-2025") for fund E while it had 14 stored prices (clean run of journey 2b, 05-10-2026), and 3 states (a 21-day hole in the stored prices) in the final run. NOT shown on DEV: the "timed out" state and the 500 "could not be generated" answer (unit tests only). |
| 22 | Cache invalidation and idempotency | **PASS** | Journey 3: a controlled +2% correction of one price raised exactly one event; only fund E recomputed; A and D blocks byte-identical; the worker invalidated only E's current-definition entries and recorded the count; a second run did nothing. Journey 3b (RBI): a correction to the repo-rate series, which no report uses, raised two events and invalidated no entry; a correction to the T-bill series (an observation of 07-06-2023, changed by +0.05 and reverted within seconds) changed the dataset version and the Sharpe of a report whose window reaches 2013 (0.48058708 to 0.48058296), invalidated all 12 entries that depend on the series, left the issued report byte-identical, and a report made after the revert shows the original Sharpe again; the PO's six reports were untouched and none was made inside the window. Limit: no entry without a risk-free dependency existed in scope, so the "independents stay valid" half is vacuous (0 of 0); the repo-series run is the negative evidence. Two defects found and fixed (3646eef, 1f3b608). |
| 23 | Concurrency / resumability / fairness | **PASS** (concurrency, resumability), fairness untested | Journey 7: six simultaneous generations produce six reports with unique contiguous versions, an unbroken supersedes chain and identical content (before the fix 4 of 6 answered 500, a98b54f); five simultaneous worker runs process the event once and report it once (before the fix they reported it five times, 1f3b608). Journey 2b: a bounded fetch resumed in chunks. Fairness across many users was not tested. |
| 24 | RLS / privacy / audit | **PASS** (after 0269) | PASS: another user gets 404 identical to a missing id for report JSON and PDF and no render token is created; free users get 403 on every verb including an invalid body; print route with no token, a made-up token, an expired token and a token naming another user's report are refused; cache, token and correction-event tables are closed to sessions; other users' reports and transactions are invisible (RLS); the server log holds no e-mail, folio or PAN. The Premium-lapsed finding (a user whose Premium lapsed still read their stored report straight from the table) was fixed by migration 0269, which the PO applied to DEV on 06-10-2026: the re-run of journey 5 shows the direct read closed (403/404 on the API, no row from the table). Verified by behaviour; the policy text itself could not be read (pg_policies is not exposed through the API). |
| 25 | UI / accessibility / mobile | **CONDITIONAL** | Browser run (Chromium, 1280 and 375 px, keyboard Tab, axe-core 4.10): report page, no horizontal scroll, one h1, no skipped level, every control named, visible focus on every stop, no serious or critical axe violation after two fixes (185f5ec: 18 sideways-scrolling tables were not keyboard reachable, amber label 3.64:1). Remaining axe findings are in the SHARED chrome, not NAV2 (sidebar Reports menu ARIA, sidebar section label contrast, shared error message contrast): task chips raised. The monitoring admin page could still not be inspected loaded, because its data call still times out on DEV after 0270 (see row 26). No screen reader was used. |
| 26 | Storage and non-held-history controls | **CONDITIONAL** | Held-only storage proven with before and after counts (row 2). The admin monitoring snapshot STILL answers statement timeout (57014) on DEV after 0270 was applied: the page shows an error, so the monitoring surface is not usable. Cause found by timing: one exact count of the price table (3,077,819 rows) takes about 3.7 s on DEV even as the service role (the row estimate takes 0.2 s). Migration 0271 (the total becomes the table row estimate, labelled approximate, unavailable when the table was never analysed; held and post-changeover figures stay exact) is written, tested against 0270 in PGlite and NOT applied. Until the PO applies 0271 and the page loads, this row stays CONDITIONAL. |
| 27 | DEV end-to-end accepted-statement journey | **PASS** | Journey 1, no seed insert: upload, parse, review summary, accepted (certified), canonical holding, held-only plan, NAV window, analytics, report, oracle, PDF. |
| 28 | Production deployment and scheduled-run evidence | **NOT STARTED** | Stage 4. |
| 29 | Recovery / rollback readiness | **CONDITIONAL** | Every switch has a tested off path on DEV: planner off = old path, correction worker off answers "skipped" and touches nothing, weekly refresh off makes no RBI request, NAV fetch off releases the report at once (after 0541731). All switches were read back OFF. A correction was applied and reverted exactly (price, checksum, data version). Migration rollbacks are written, not exercised. |
| 30 | Remaining PO decisions | **OPEN** | See section 6. |

## 4. Defects found and fixed in this pass (each its own commit, each with a test that fails before the fix)

Frozen base: `d0708e2`. A new SHA means the DEV copy must be switched again.

| Commit | Defect (found by) | The test that fails before the fix |
|---|---|---|
| `0541731` | With `nav2_trigger_planner` ON and the NAV fetch switch OFF the report answered "preparing" forever: the planned fetch is a no-op that leaves no attempt record, so no cooldown ever released it (DEV, journey 2b: an endless 202 loop). The planner step now holds only when the fetch switch is cleanly ON. | `nav2FundAnalyticsService.test.ts` NC-S8 (expected `ready`, got `preparing`) |
| `3646eef` | After a correction and its revert the recomputed bundle could not be cached again: the worker had invalidated the row and the unique key blocked the new one, so that fund was recomputed on every report (DEV, journey 3: E had 0 valid entries after the revert). Refreshing an invalidated row for the same content-addressed key is correct; a valid row is never touched. | `nav2BundleKeyInvalidation.test.ts` NC-K6 |
| `a98b54f` | Four of six simultaneous generations for one user answered 500: the version race was retried once (DEV, journey 7). Now up to 10 tries with jitter, then the typed "could not be saved". | `nav2FundAnalyticsService.test.ts` NC-S9 |
| `1f3b608` | Five simultaneous worker runs each reported the same event and its invalidations (reported 10, recorded 2). Counts now come from the rows the run actually changed and an event is counted only by the run that claimed it. | `nav2CacheWorkerAndRiskFreeLoader.test.ts` NC-W4 |
| `185f5ec` | axe-core on DEV: 18 sideways-scrolling tables at phone width not keyboard reachable; the amber "unavailable" label 3.64:1 on white. Wrappers are focusable named regions, the label colour is 5.9:1. | `nav2ReportViewAccessibility.test.ts` NC-A1, NC-A2 |
| `0d61806` | Migration **0269**: a user whose Premium lapsed could read their stored report straight from the table (journey 5). Applied to DEV by the PO on 06-10-2026 and proven closed by the journey 5 re-run. | `nav2Stage3Rls0269.test.ts` (reproduces the defect with the 0261 policy, then proves 0269) |
| `ca3c480` | Migration **0270**: the admin monitoring snapshot returned a statement timeout on DEV (its page showed an error). Applied to DEV by the PO on 06-10-2026: it did NOT cure the timeout (see 0271). | `nav2Stage3Monitoring0270.test.ts` (identical figures to 0262; three table-wide scans become two) |
| the 0271 commit | Migration **0271**: the monitoring snapshot still timed out after 0270 because one exact count of the whole price table takes about 3.7 s on DEV. The total becomes the row estimate, labelled approximate. **Hand-over: NOT applied.** | `nav2Stage3Monitoring0271.test.ts` (0270 has the unbounded count, 0271 has none; figures equal after ANALYZE; labelled approximate; unavailable when never analysed) |
| `89e3c65` | hand-over notes `docs/nav2/po_apply_0269_0270/README.md` | - |

## 5. Findings NOT fixed here, and why

Outside NAV2 code (a task chip was raised for each; nothing here was changed):

1. **Publish route, non-UUID `correlationId`**: the publish route answers 500 and leaves one deactivated duplicate `investments` row per attempt (found while testing publish and republish; the count went 3 to 4 to 5 with zero publications). With a valid UUID publish, repeat publish, unpublish and repeat republish create exactly one investment and one active publication.
2. **Shared chrome accessibility** (axe-core): the sidebar Reports menu has invalid ARIA (critical), the sidebar section labels are 3.58:1 and the shared error message box is 4.23:1.
3. **NAV fetch rate limit counts refused attempts**: while the fetch switch is off each attempt writes an audit event the per-hour limiter counts, so a user was rate-limited with nothing fetched.

NAV2 findings not fixed and why:

4. **0269 and 0270 are not applied** (no DDL path from the agent): rows 24, 25 and 26 stay CONDITIONAL until the PO applies them to DEV and the checks in `docs/nav2/po_apply_0269_0270/README.md` pass. The monitoring fix is proven equal on synthetic data, not on timing.
5. **Joint holding valued at the full account value** in the personal report (not the 50% share). Observed, not changed: a product decision.
6. **Seven DEV instruments are incoherent** (name of one fund, AMFI code of another), so a statement can resolve to a wrongly named fund on DEV. Data repair, not NAV2 code.
7. **Provider fidelity**: two of 1,599 loaded prices differ from, or are absent in, the second source; which is right is not known.
8. **Not demonstrated on DEV**: the "timed out" and "could not be generated" states (unit tests only); agreement with Dashboard, Holdings, Investments and Performance for the same timestamp; fairness across many users; a screen reader; production.
9. **Single-fund PDF cover**: the cover of a one-fund report is 30% empty at the foot (the layout judge's limit is 30%, it flagged 30.x%). It is a short document, not a fault, but it is the judge's edge.
10. The manifest checksum covers the calculation timestamp, so two identical reports made seconds apart have different checksums (their content is identical; journey 7 compares the manifests ignoring the timestamp).
11. The security gaps already listed in `CAPABILITY_SEGREGATION.md` (no re-authentication step, no preview for a series switch, no dual control) are unchanged.

## 6. What a PO has to do, and the cleanup commands

PO actions (things only the PO can do or decide):

1. Apply migrations 0269 and 0270 to DEV (`docs/nav2/po_apply_0269_0270/README.md`), then open the monitoring admin page as an administrator and run `node scripts/nav2_stage3/j5_security.mjs`: the "PREMIUM LOST, DIRECT DATABASE READ" check must pass.
2. Switch the DEV copy to the new HEAD (stated in the final report); the report generation, cache and accessibility fixes are in code, not in the database.
3. In your own browser, with a real CAMS file and your own session (the agent cannot use either): generate Version 7 and look at the report page and the PDF on a phone. The agent's checks used fixture users and a headless browser.
4. Decide: joint holdings valued at the full account value or the owner share; the CAGR convention difference with the Performance tab; the NAV1 inception-policy conflict.
5. Repair or confirm the seven incoherent DEV instruments if statements are to be trusted on DEV.

Cleanup commands (run only when the coordinator says so):

- The PO seed (their holdings and derived rows). From `D:\FHIP\.claude\worktrees\agent-a4a5a1a468ed1be5e\docs\nav2\stage3_seed`: `node cleanup.mjs` (dry run first), then `node cleanup.mjs --apply --include-derived`. **Warning:** `--include-derived` also deletes every report version of the PO account (Versions 1 to 6 and any Version 7). Run it last.
- The fixture-user data this pass created (from this worktree, DEV only): `node scripts/nav2_stage3/reset_user.mjs holder`, then `other`, `free`, `spare`, `admin` (each removes that user's statements, accounts, transactions, holdings, publications, reports); `node scripts/nav2_stage3/setup.mjs revert` puts their country-confirmation and plan rows back; `node scripts/nav2_stage3/flags.mjs off` shows and re-asserts the four switches OFF. Not removed by design: the append-only audit events, the correction ledger rows of the controlled correction and its revert, the 30-day retention holds (they expire), and the 1,599 real AMFI prices loaded for fund E (reference data).
- Stop the local app: end the node process listening on port 3981 only.

## 7. Tests run on the final code

- `tests/unit/nav2`: 40 files, 636 tests, all pass together, and under `--sequence.shuffle` seeds 1, 2 and 7. (d0708e2 had 37 files and 624 tests; the new ones are NC-S8, NC-S9, NC-K6, NC-W4, NC-A1, NC-A2 and the two migration suites.)
- `tsc --noEmit`: exit 0. `eslint` on the changed source and test files: no findings.
- The five tests that already fail on `origin/main` (`docs/nav2/BASELINE_FAILURES.md`) were not touched.
- Every new test was run against the code before its fix and failed there (named in section 4).
- Not run: the full repository suite and the production build in this pass.
