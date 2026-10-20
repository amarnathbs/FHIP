# Fund analytics: one consolidated front summary in the combined PDF, 20-10-2026

Branch `feat/fund-analytics-combined-summary-20261020` (origin/main `534bfb0`, then merged with origin/main `f9a42ed`). Not pushed, not merged. No migration, no secret, no production or DEV access. Admin standard: not affected. Evidence labels: UNIT-TESTED, RENDERED (real Chromium 151, synthetic fixtures from the real report engine), NOT PERFORMED.

## What changed (combined print only: `?ids=a,b[,c,d]`)

The combined document used to repeat each report's cover (summary table, notes, "How to read"). It now has ONE front section, then only each report's fund pages.

**Front section (page 1, named page `fa0`, header "Versions 4 and 5")**
* the intro line (unchanged text), then "Fund analytics report", the as-at date and period, one line per report ("Report 1 of 2: Version 4, made ..., (10 funds)"), the saved-report sentence, the count sentence;
* **All your funds at a glance**: ONE table, every fund of every report exactly once, largest current value first (a fund with no value last, ties keep report order). Same columns, same period label ("Fund CAGR, 3 year"), same cells and footnote letters as the per-report table. Built only from the reports' saved results through the same row function the single report uses (`summaryRowFor`); nothing is recomputed. One footnote list for the table, so the letters never repeat;
* **Notes**: ONE merged list (rules below);
* ONE "How to read this report" (the same block, now a shared component).

**Each report** then starts on a fresh page (its own named page `fa1`, `fa2`, ..., its own version in the header) and holds ONLY its fund pages and its own comparison, headed "Comparing the funds in report 1 (Version 4)". A report that cannot compare keeps its small "not applicable" block under that heading (every statement kept). "Page n of N" runs across everything (document-wide counter).

**"How this was calculated"**: identical text in every report -> printed ONCE, at the start of the first report's pages (under report 1's header, before its first fund); different texts -> each report's own, in its comparison section.

## Merged notes: the rules (`lib/reports/fundAnalyticsCombinedSummary.ts`)

Only the reports' own notes are used; nothing is invented.
* Identical note text in every report: once, no label (risk-free source, the household facts such as "3 statement lines are waiting...").
* A note whose text differs, or that only some reports carry: each variant printed with its reports named ("Report 1 (Version 4): 3 statement lines are waiting ...", "Report 2 (Version 5): 2 statement lines ..."), variants listed together. Counts are **never summed** (the same statement lines would be counted twice).
* "This report covers X of your Y Indian mutual funds, as you chose..." is restated for the document from the reports' own numbers: "This document covers 7 of your 17 Indian mutual funds in 2 reports. The others can go in another report." or, when the reports together hold every fund, "This document covers all 7 of your Indian mutual funds in 2 reports." If the reports disagree on how many funds are held, each report's own numbers are printed with its report named.
* "Figures are as at ..." (with "information, not a recommendation to buy, sell or switch") stays LAST; identical dates: the original sentence; different dates: the same sentence template with "01-10-2026 (report 1, Version 4); 05-10-2026 (report 2, Version 5)".
* A note about one named fund ("Price history for X could not be loaded ...") is kept as it is.
* The fund pages' "see note N" pointer to the risk-free note follows the merged numbering per report (a stale single-report number would name the wrong note).
* A fund that two reports both cover (only possible by typing ids by hand) is listed once, from the first report, with a plain note.

**Different as-at dates or periods: chosen behaviour.** Not refused, not merged silently. The front says "These reports were made for different dates or periods, so their figures are not directly comparable:" and lists each report's as-at date and period, the table gains a "Report" column, and the merged as-at note names both dates.

## Evidence

**UNIT-TESTED** (`fundAnalyticsCombinedSummary.test.ts` 21 tests, `fundAnalyticsCombinedPrint.test.ts` 40, `fundAnalyticsGenerateAll.test.ts` 32; the 69 nav2 / fund-analytics / print files = 1121 tests pass; tsc shows only the 2 known errors; eslint clean on touched files):
* single table has every fund exactly once and sorted; no per-report "Your funds at a glance", cover, notes or "How to read" remains (one of each in the output); each fund's row equals the single report's own row and its footnote marks carry the same explanations;
* merged notes with a fixture where Note 1 (statement lines) and Note 3 (covers) differ: labelled variants, no sum, restated coverage, disagreement fallback, disclaimer preserved and last;
* different as-at date and different period handled (listed, Report column, both dates in the note);
* each fund page's markup and each comparison are the single document's verbatim (apart from the heading and the once-only method note); the method note once vs per report;
* **golden**: the single-report print document hashes (SHA-256 of the server markup, 5 fixtures x 3 variants, taken on origin/main BEFORE the refactor) are unchanged;
* ownership refusal, cap of 4, title, page rules and the earlier combined tests still pass (updated where they pinned the old structure);
* negative controls: NC-CS1 concatenated notes, NC-CS2 unsorted rows, NC-CS3 differences hidden, NC-CS4 stale "see note" number, NC-CS5 un-restated "This report covers" (each shown to fail on the mutated copy), plus the earlier NC-CP1..5.

**RENDERED** (`npx tsx scripts/print/faPrintLayoutCheck.ts --combined <fixtures> [--prod-notes]`; `--prod-notes` adds the notes a production report carries: statement lines, "covers X of your Y"). Page numbers "Page n of N" ran 1..N across all sections and every page header named its own section in every run below; the intro is on page 1 only; one "All your funds at a glance"; "How to read" once.

| Set | Pages (before this change) | Pages now | Fill % per page | Front section | Reports' pages start |
|---|---|---|---|---|---|
| 10 + 7 funds, realistic notes | 21 | **20** | 97 96 98 89x8 81 \| 92 89x6 67 | 1 page (97%) | 2 and 13 |
| 10 + 10 + 4 (24 funds) | 30 | **29** | 99 15 96 98 89x8 81 \| 92 89x8 81 \| 92 89 89 89 59 | 2 pages, 2nd 15% full | 3, 14, 25 |
| 10 (long names, young) + 7 | not measured | 21 | 99 5 100 98 87 89x7 93 \| 92 89x6 67 | 2 pages, 2nd 5% full | 3 and 14 |
| 10 (long names) + 7 | not measured | 21 | 98 7 100 98 91 89 91 89 93 89 91 89 86 \| 92 89x6 67 | 2 pages, 2nd 7% full | 3 and 14 |

The single report is unchanged: 10 funds 12 pages, 7 funds 9, 1 fund 2 (same fill as before).

**The stranded method-note page (PO's production PDF, page 13).** Cause: the 3-line "How this was calculated" note was the last block of report 1's comparison, and report 1 ended exactly at a page boundary. Now the note is printed once at the start of report 1's pages, so report 1's last page is a normal one (81% to 93% in every run above); the stranded page is gone in the combined document. It is NOT moved to the front: with realistic notes it did not fit page 1 for 17 funds (it spilled alone to a 7% page 2), so it sits at the top of report 1's pages instead. The single-report print still has the stranded-note case (unchanged, as asked).

## Honest limits

1. **A front section longer than one page ends on a partial page.** 17 funds with realistic notes fit one page (97%); 24 funds, or long fund names (a table row wraps to 2 or 3 lines), push the tail onto a short second page (5% to 15% full) before report 1 starts on its fresh page (the header names a different section, so the next report cannot flow onto that page). This is the one remaining short page; a real 17-fund household with long names such as the PO's may hit it. Mitigations tried: tighter table rows and notes, wider name column (these made 17 funds fit). Not done: letting report 1's pages continue on the front's last page (would show one header for two sections).
2. The method note under report 1's header applies to every report in the document; it is not labelled as such beyond its position (identical text only).
3. For reports with no comparison possible, the small "Comparing the funds in report N" block (not applicable lines) is kept rather than dropped.
4. Not performed: any run against DEV or production, a person's real 17-fund report, the browser print dialog (the PDFs are Chromium `page.pdf` with the page's own `@page` rules), Firefox or Safari (no page margin boxes: no header or page numbers there, as for a single report).
5. `scripts/print/faPrintLayoutCheck.ts --combined` does not count a short last front page as a failure (it prints it as INFO with its fill).
