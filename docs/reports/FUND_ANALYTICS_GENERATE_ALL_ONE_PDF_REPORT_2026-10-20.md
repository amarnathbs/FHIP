# Fund analytics: "Generate all my funds" and one PDF for the set, 20-10-2026

Branch `feat/fund-analytics-generate-all-one-pdf-20261020` (from origin/main `04804c7`). Not pushed, not merged. No migration, no secret, no production or DEV access, no new API. Admin standard: not affected (no `app/(app)/admin/**`, `app/api/admin/**`, admin navigation, role or RPC is touched).

Evidence labels: **UNIT-TESTED** (vitest, no browser), **RENDERED** (real Chromium 151 through Playwright, synthetic fixtures made by the real report engine, no login, no database), **NOT PERFORMED** (stated plainly).

## Decision implemented (PO, 20-10-2026, option B)

One report still covers at most `FUND_ANALYTICS_MAX_FUNDS` (10) funds. The cap, the 22 s request budget and the 28 s platform limit are unchanged. A person who holds more can press one button and the screen asks for their reports one after the other. The saved reports can then be printed as ONE PDF.

## Before and after

| | Before | After |
|---|---|---|
| 17 funds | choose 10, generate, press "Choose the other funds", choose again, generate again (and again print two PDFs) | one click on **Generate all my funds (2 reports)**: report 1 = the 10 largest, report 2 = the other 7; progress shown; one **Save all as one PDF** |
| A failure halfway | the person had to work out which funds were left | batch 1 stays saved, the funds not covered are named, **Try the remaining funds again** asks only for them |
| Two reports, one file | impossible (two print jobs, two PDFs) | `/reports/fund-analytics/print?ids=<a>,<b>` = one print job = one PDF, "Page n of N" across both |
| Stranded last page | 3-line "How this was calculated" alone on page 13 in some 10-fund reports | **not changed**, see the last section |

## SCOPE A: Generate all (client)

Files: `lib/reports/fundAnalyticsGenerateAll.ts` (pure logic), `components/reports/FundAnalyticsReportClient.tsx` (wiring and states), `components/reports/FundPickPanel.tsx` (a second button).

**Where the button is.** (1) In the "Choose up to 10 funds" panel (the server's 409 `select_funds` answer), next to "Generate a report for these funds". (2) Next to "Choose the other funds" under a report that left funds out ("This report covers 10 of your 17 funds."). From (2) the screen first sends the existing request without a choice; the 409 answer lists every held fund with its value (`candidates`, `max`, `heldFundCount`), and the batches are planned from it. No new API.

**Batches.** `planBatches`: held funds sorted by current value, largest first (a fund with no value last, ties in list order), cut into chunks of `batchSize(max)` = `min(server max, 10)`, at least 1. A repeated id is counted once, so every fund is in exactly one batch. 17 funds = 10 + 7, 21 = 10 + 10 + 1, 10 = one batch.

**Sequencing.** `runBatches` awaits each request before it starts the next (the request and the 15 s wait are injected, so it is tested without a browser). Each batch sends `POST /api/reports/fund-analytics` with `{ period, funds: [ids] }` and its own `Idempotency-Key` (a UUID from the same helper as the single report). The screen's single-report path and this one share the `inFlight` flag, so two requests can never be in flight at once.

**Per-batch retry handling (same as today).** 202 (prepared in steps) and 503 `timed_out` mean "ask again with the SAME key": every 15 s, up to 40 times (10 minutes). After that the batch is "not ready", its key is kept and the message says nothing was lost. A server answer that is an error (403, 404, 422, 500) drops that batch's key, like the single report; a network failure with no answer keeps it (the request may have been accepted).

**Never a duplicate.** The key of a batch is kept for the life of the screen (`plan period | fund ids`). Pressing "Generate all" again after success sends the same keys, the server replays (200, `replayed`) and no new version is made. A saved batch is never asked for again on "Try the remaining funds again". A page reload makes new keys (the same as "Generate a new version" today: a deliberate new run makes new versions).

**States shown** (plain wording, `role="status"`, `aria-live="polite"`):

* running: "Making all your reports, one after the other." then one line per report: `Report 1 of 2: 10 funds - ready`, `Report 2 of 2: 7 funds - being made` / `- waiting` / `- price history is being prepared (3 of 7 loaded); this screen checks again by itself`;
* done: "All your funds are covered.", **Save all as one PDF** (only when the set is 2 to 4 reports), the single-report **Print / Save as PDF** still works for the report shown (the first, largest-funds report is loaded when the run ends; both versions are in the Version list);
* partial: "Some funds are not covered yet." with the failed batch's reason on its own line and `Report 1 of 2 is saved and kept. Report 2 of 2 is not ready. 7 funds not covered yet: <names>.` and **Try the remaining funds again**.

The first failed batch stops the run (later batches stay "waiting", i.e. not covered). A batch the server says has nothing to report on (`no_funds`) is skipped and the run goes on. A fund with no price history is handled by the server exactly as in the single report (202 waiting, then unavailable in the report); the client adds nothing.

**Server remains authoritative.** Nothing on the server changed for this scope. It still refuses more than 10 funds (422), a foreign fund (422, the same message), a free user (403) and checks tenancy. The client's `min(server max, 10)` is defence in depth only.

## SCOPE B: one PDF for the set (print page)

Files: `app/(print)/reports/fund-analytics/print/page.tsx` (`?ids=`), `components/reports/FundAnalyticsCombinedPrintDocument.tsx`, `lib/reports/fundAnalyticsCombinedPrint.ts`, a prop and a few CSS lines (`combinedPart`, `.fa-combined-*` in `app/globals.css`).

**Address and refusals.** `?ids=<id1>,<id2>[,<id3>,<id4>]&print=1&tz=...`. `parseCombinedIds` returns the ids in order, each once, and REFUSES (404, the same page as an unknown report): nothing given, an empty entry, anything that is not a UUID, a repeated `ids` parameter, more than 4 distinct ids (hard cap, `COMBINED_MAX_REPORTS`). The page checks Premium first, then reads every report with the signed-in user's id as the filter (`getFundAnalyticsReport(supabase, user.id, id)`); if ANY id is not the user's own or does not exist, the whole page is a 404 and nothing of the others is shown. The token path (headless renderer) comes first and is untouched; `?id=` is unchanged.

**One document.** Each report is rendered by the UNCHANGED `FundAnalyticsPrintDocument` (its own cover, summary, notes, funds, comparison). What is added: a one-line explanation at the start, e.g. "This document combines 2 reports covering your 17 funds. Funds are compared only within the same report."; one NAMED PAGE per report (`fa1`, `fa2`, ...) so report 2 and later start on a fresh page and each page's running header names its own report's version ("Version 4, made ..."); the page counter is the document's, so the footer reads "Page n of N" with N the total. The size, margins and other margin boxes of `fa1`.. are generated from the same values as `@page fa` (a unit test compares the two). The `html{--fa-print-version}` variable of the single document is switched off for a part (it would have shown the last report's version on every page).

**Title** (default file name of Save as PDF): `FHIP Fund Analytics - October 2026 - Versions 4 and 5` (three: `Versions 4, 5 and 6`). Month in words, from the latest as-at month of the reports; versions ascending; file-name safe; falls back to the plain name on any missing or malformed part. One report gives the existing single title. Set through `generateMetadata` and the toolbar's `documentTitle`.

## Evidence

**UNIT-TESTED** (`tests/unit/fundAnalyticsGenerateAll.test.ts`, 32 tests; `tests/unit/fundAnalyticsCombinedPrint.test.ts`, 32 tests):

* batches: 17 = 10 + 7, 21 = 10 + 10 + 1, order by value, null last, every fund once, never more than 10 per batch even when the server says 25, 1000, NaN or nothing;
* sequencing: calls are one after the other (a fake server counts concurrency, max 1), batch 1's funds first, one key per batch, a 202 / 503 is re-asked with the same key after 15 s and then the run goes on, 40 checks end the run with the key kept;
* idempotency: a second run with the same keys makes no new report (the fake server issues one report per key);
* partial failure: batch 2 fails, batch 1 kept, the 7 funds named, none of the 10 named, retry asks only for batch 2, a network error keeps the key, `no_funds` is skipped, a cancelled run asks for nothing more;
* the screen wiring (source scan): no `Promise.all`, every request carries `Idempotency-Key` and the period, the run shares `inFlight`, the "Save all as one PDF" condition;
* combined print: the address rules (including 5 ids, a bad id, empty entries, repeated parameter), the title, the intro line, the generated `@page` rules equal `@page fa`, markup of two different batches (each report's markup appears verbatim and in order, two comparisons, the intro once before the first cover), the print page with a mocked store: own ids render in order and read with the signed-in user's id, one foreign or unknown id among own ids is a 404 (in any position), 5 ids or a malformed id are refused before any read, a free user is refused before any read, the combined title through `generateMetadata`, `?id=` unchanged, the token branch untouched.
* NAMED NEGATIVE CONTROLS (the guard is removed in a copy and the same check is shown to fail): NC-GA1 unclamped planner (more than 10 per batch), NC-GA2 parallel runner (concurrency 2), NC-GA3 new key per request (copies), NC-GA4 saved batch asked again, NC-GA5 no de-duplication; NC-CP1 no cap (5 ids), NC-CP2 page that does not refuse when any report is missing, NC-CP3 reading with another user id, NC-CP4 per-report version variable left on, NC-CP5 unsafe file-name character, and a page without the Premium check before reading.
* One existing assertion was updated because the code it pins moved: `tests/unit/fundAnalyticsPrintLayoutAndPicker.test.ts` expected `if (token || !id) return fallback;` and now expects `if (token || (!id && ids === undefined)) return fallback;`.
* The 68 nav2 / fund-analytics / print files (1092 tests) pass. `tsc --noEmit` shows only the two known errors (`tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, `tests/unit/aiProductionProofPackPglite.test.ts(174,25)`); eslint is clean on every touched file.
* Full suite (`npx vitest run`, run on the committed code): 831 files passed, 49 files failed (36 tests), 15886 tests passed. None of the 49 failing files imports or names anything this change touched (checked by search for the fund analytics, print, picker and stylesheet names). Re-run in isolation, 46 still fail for reasons outside this work: no `.env.local` in the worktree, content files that exist only in the main checkout (`content/consolidated/...`), a `vi.mock` missing an export (`canBulkImportResources`), 5 s timeouts and Vite temp-file errors under load, admin / promo / resources migration-sweep tests, and `dateFormatVisibleTextGuard` which flags `lib/reports/printDocumentTitle.ts` (`Intl.DateTimeFormat('en-GB', ...)`), a file this branch does not change (identical to origin/main). I did not run a baseline of origin/main for these, so "pre-existing" rests on that evidence, not on a baseline run. `git checkout -- scripts/` was run after the suite.

**RENDERED, the combined document** (`npx tsx scripts/print/faPrintLayoutCheck.ts --combined funds-10,funds-7`; the second report is made a different set of funds, as a second batch is; the PDF is written with `page.pdf({ preferCSSPageSize: true })`, which is what the print dialog does with the page's own `@page` rules):

| Set | Pages | Fill % per page | Reports start on | Page numbers | Header per page |
|---|---|---|---|---|---|
| 10 + 7 funds | **21** (12 + 9) | 82 89 89 89 89 89 89 89 89 89 89 89 / 96 91 91 91 91 91 91 93 50 | 1 and 13 | "Page n of 21", n = 1..21, every page | pages 1-12 "Version 4", 13-21 "Version 5" |
| 10 + 10 + 4 funds | **30** (12 + 12 + 6) | 82 89x11 / 78 89x11 / 89 91 91 91 94 42 | 1, 13, 25 | "Page n of 30", n = 1..30 | per report |

The explanation line is on page 1 only; the last page of report 1 is 89% full (the fresh start of report 2 does not leave a mostly blank page here; a report whose own last page is short, such as 7 funds at 50%, simply ends short before the next report). Negative control: with every part given the SAME page name the same script FAILS (every page 1-12 shows "Version 5"), so the check can fail. Page images were inspected (page 1 with the intro line, page 13 with report 2's own cover and funds).

**RENDERED, the screen** (`npx tsx scripts/print/faGenerateAllScreenCheck.ts`; the REAL `FundAnalyticsReportClient` in Chromium with `fetch` replaced by a scripted server holding 17 funds: 409 choose-funds answer, one report per Idempotency-Key, a repeated key replayed with 200, 250 ms per request): 25 of 25 checks pass. A: the panel offers "Generate all my funds (2 reports)"; the calls are the probe, then 10 funds, then 7 funds; never two in flight; batch 2 started only after batch 1 ended; two distinct valid keys; exactly 2 reports; lines read "Report 1 of 2: 10 funds - ready", "Report 2 of 2: 7 funds - ready"; "Save all as one PDF" points at `...print?ids=<id1>,<id2>&print=1&tz=...`; the single "Print / Save as PDF" still points at `?id=<id1>`. B: pressing again re-sent the same two keys, 2 reports in total. C: batch 2 fails once: batch 1 stays "ready", message names the 7 funds, no "Save all" link, "Try the remaining funds again" sends exactly one request (7 funds), 2 reports at the end, "Save all" appears.

**NOT PERFORMED**: any run against DEV or production (the real 22 s budget per batch with 10 + 7 real funds, the real price-history steps, real Premium); the browser's own print dialog (Firefox and Safari have no page margin boxes, so there the header and "Page n of N" are absent, the same limit as a single report today); a person's real report with 17 funds.

## Honest limits and decisions to know

1. **Keys live as long as the screen.** Pressing "Generate all" again in the same visit replays the saved reports. To make fresh versions of all funds, reload the page (or use "Generate a new version" for a single report). This is the idempotency behaviour the brief asked for.
2. **The first failed batch stops the run.** With 3 batches, if batch 2 fails, batch 3 is "waiting" and counted as not covered. "Try the remaining funds again" asks for batch 2 then 3.
3. **"Save all as one PDF" appears only when every fund is covered and the set is 2 to 4 reports** (up to 40 funds). Beyond 40 funds the screen says to print each report separately. After a partial run only the individual "Print / Save as PDF" is offered.
4. **The month in the title is the latest as-at month** of the reports; versions can be non-consecutive ("Versions 3 and 5").
5. **The comparison is only within one report** and the document says so once at the start. Nothing in a saved report, its figures or its text was changed (a unit test proves each report's markup is contained verbatim).
6. Each batch costs one request with its own 22 s budget; the engine's per-fund cache is shared, so a repeat run is faster. A production timing of 10 + 7 funds has not been taken (NOT PERFORMED).
7. The hard cap of 4 ids is on the server; `ceil(held / 10)` is what the screen produces (2 for 17 funds). A person can also type `?ids=` by hand with any of their own report ids (up to 4); that is allowed and only ever shows their own reports.

## ALSO: the stranded "How this was calculated" page (NOT changed, reported)

Reproduced with the repo's tool: `funds-10+long+young` = 13 pages, fill 84 93 89 87 89 89 89 89 89 89 89 93 **7**; page 13 holds only the 3-line note, page 12 is the full comparison. The short-name 10-fund fixtures end 89 to 96% and do not show it, so it depends on how long the comparison runs.

Tried the one simple rule that could move the note with its neighbour, `break-before: avoid` on `.fa-calc` (the note is not allowed to start a page): the table above it is allowed to split between rows, so only its last row moved with the note: page 12 = 89%, page 13 = **11%** (still stranded, now with one table row). A real fix needs either about 8% less content in the compact comparison or moving the note somewhere that always has room (the cover page); both change the document's design and measured pages for every report, which risks the layout the PO accepted on 19-10-2026. The rule was reverted; nothing changed. Recommendation, if wanted: print the note on the cover under "How to read this report" for reports with more than 6 funds (cover has about 16% free at 10 funds), measured first with `faPrintLayoutCheck.ts` on `funds-10+long+young`, `funds-12`, `funds-10`.

## How to re-run the evidence

```
npx vitest run tests/unit/fundAnalyticsGenerateAll.test.ts tests/unit/fundAnalyticsCombinedPrint.test.ts
npx tsx scripts/print/faPrintLayoutCheck.ts --combined funds-10,funds-7 --shots <dir>
npx tsx scripts/print/faGenerateAllScreenCheck.ts --shots <dir>
```
