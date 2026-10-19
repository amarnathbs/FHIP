# Fund analytics: print layout (no empty space) and fund picker, 19-10-2026

Branch `fix/fund-analytics-print-layout-and-picker-20261019` (from origin/main `44ff8d6`). Not pushed, not merged. No migration, no secret, no production or DEV access.

## What the Product Owner saw

A production report of one fund printed as 3 pages: the summary used about 60% of page 1, the fund page filled page 2, and "Comparing your funds" had a page of its own that said "Not applicable" and "You need at least two funds" plus the risk-free note (about 80% blank). A 10-fund production report printed as 14 pages: "Note 4" and "How to read this report" alone on page 2 (about 80% blank) and the last two correlation rows plus "How this was calculated" alone on page 14 (about 70% blank).

## Root causes

1. `break-before: page` on every fund and on the comparison section, and `break-inside: avoid` on the whole fund page and on the whole comparison. A short summary, a one-line comparison or a tall fund each left a page mostly empty.
2. A chart caption (`.fa-sub`, which keeps with what follows it) was the last line of a fund's head, so Chromium moved head and body together (found while building the new layout).
3. 10 funds with long names: the summary table wrapped to 3 and 4 lines per fund (fund column 34%), so Notes and "How to read" spilled.
4. The comparison for one fund always printed as a full section.

## What changed (print only; the screen rules are untouched)

* **Flow, no forced breaks.** A fund is a *head* (name, price facts, chart) and *blocks* (each a heading with its table) in two balanced columns. Every head, block, ranking, correlation table of 6 rows or fewer, and the method note is kept whole; a page may end between them, never inside a chart or a table. Only the two-page fallback plan (sheet A / sheet B) still starts each sheet on a fresh page.
* **Fund names.** With more than one fund each body opens with a one-line tag (`<fund>: returns, risk and your own money`), because a page can now begin with a body. One fund adds no tag.
* **A report that cannot compare** (one fund, or no peers and no correlation) prints ONE small block after the last fund: the three "not applicable" lines, the "You need at least two funds..." line and "How this was calculated" (the risk-free note), all text unchanged. Two or more funds that can be compared keep the full (or compact above 5 funds) section and flow.
* **Summary tightened** (print only): fund column 44%, 8.5 pt table, notes and how-to-read at 8.5 pt, smaller saved-report box. The comparison's name columns are wider.
* **Browser header/footer.** `@page fa` now declares a header box (report name, version line) and a footer box ("Page n of N"), the same approach as the Monthly report; Chromium then prints none of its own date, title and address. The headless-renderer path (token) switches the boxes off, as the Monthly report does, because it draws its own.
* **The export's one-page measurement** (`oneFundPerPageFits`) now checks each kept piece (head, block) fits a page, not the whole fund, because a fund may now straddle pages. The two-page fallback is therefore rare.
* **Version time zone (coordinator's extra item).** The printed "made" time was the server's zone (UTC, unlabelled: 11:08 am) while the screen showed the viewer's (10:08 pm). The screen now sends its IANA zone in the print address (`&tz=`); the print page validates it (`isKnownTimeZone`) and formats date and time in that zone (`formatDateTimeMinutes(..., timeZone)`, day-first, the date moves with the zone), so the printed line equals the screen. With no zone (a headless render, a typed address) the line says `... 11:08 am UTC`. The renderer's own header template is labelled UTC the same way.
* **PDF file name (coordinator's extra item).** The print page title (which a browser proposes as the "Save as PDF" file name and prints in its header line) was the same for every report. `generateMetadata` on the Fund analytics print page now sets `FHIP Fund Analytics - October 2026 - Version 3` (the report's as-at month in words and its version; `lib/reports/fundAnalyticsPrintTitle.ts`; no slash, colon, pipe or other file-name-unsafe character). Only the person's own `?id=` path reads the report for the title; the headless renderer's single-use token is never spent on it (it keeps the plain "FHIP Fund Analytics"). Other reports' print pages were not touched. Unit-tested (months, file-name safety, negative controls, source contract); not rendered in a real browser's Save dialog.
* **Picker (Task B).** New `FundPickPanel` (the shared admin `Btn`, 44 px, focus ring; `flex-wrap` so it fits a phone) with real buttons **Clear all** and **Select the 10 largest** above the list, and the existing live "N of 10 chosen" counter. Rules are pure functions in `lib/reports/fundPicker.ts`: the 10 maximum is enforced in one place (a box beyond 10 is disabled unless already ticked; a tick beyond 10 is refused), "Select the 10 largest" restores the server's suggested default, "Clear all" empties (Generate stays off until one is ticked). No API change; the preselect, suggested-ids and idempotency-key code is unchanged.

## Measured in real Chromium 151 (Playwright headless shell, no credentials, synthetic fixtures from the real report engine)

Method: `npx tsx scripts/print/faPrintLayoutCheck.ts` renders the REAL `FundAnalyticsPrintDocument` (with the print tab toolbar) the way the person's own print tab prints it (A4, the page's own `@page`, background graphics off), measures every page of the PDF with pdf.js (how far down the text area the last ink reaches), and prints a second copy with the Chrome command line and its default header and footer to look for Chrome's own date, title, address and counter. "Before" is origin/main `44ff8d6`, same script and fixtures.

| Fixture | Before: pages (fill % per page) | After: pages (fill % per page) |
|---|---|---|
| 1 fund | **3** (63, 88, 38) | **2** (95, 94) |
| 2 funds | 4 (66, 88, 88, 44) | 4 (100, 89, 94, 22) |
| 4 funds | 6 (71, 88, 88, 88, 88, 61) | 6 (89, 91, 91, 91, 94, 42) |
| 10 funds, short names | 12 (85, 88 x9, 73) | 12 (78, 89 x10, 89) |
| 10 funds, production shape (long names, 3 ranked, 7 unranked, like the PO's report) | **14** (98, **13**, 90, 88, 90, 88, 90, 88, 90, 88, 90, 88, 97, **11**) | **12** (90, 93, 89, 91, 89, 91, 89, 93, 89, 91, 89, 94) |

After: no page but the last under 78% full (the last page is a natural tail; 2 funds ends with a 22% tail because the correlation table of 1 row plus the method note did not fit under the rankings and a table is not split). Before and after both have no landscape page and no text under 7.4 pt. After: Chrome's own header and footer are absent in the command-line print for every fixture, and "Page n of N" is on every page (before: Chrome's date, title, address and counter on every page).

Also rendered through the export route's own server options (`scripts/nav2_pdf_layout_check.ts`, Playwright `page.pdf` with its own margins, header and footer, then PyMuPDF): 1 fund 2 pages; 2 funds 4; the stored 4-fund report 6; 8 funds with an unavailable, a redeemed, a long-named and a young fund 10; 12 funds 14; 20 funds 23; 25 funds 28; the two-page fallback plan for 4 funds 10. All pass the judge (no page but the last more than 35% empty, no split row, no collision, no text under 7.5 pt).

The server-render path was probed separately (`scripts/print/faSsrHeaderProbe.ts`): the document rendered with `renderToStaticMarkup` (as the route does) prints the header "Version 2, made 19-10-2026, 10:08 pm" on every page.

## UNIT-TESTED (vitest, no browser)

`tests/unit/fundAnalyticsPrintLayoutAndPicker.test.ts` (41 tests): the one-fund markup (compact "none" block, every line and note still printed once, the method note inside the same section, no tag, no ISO date); 2, 4 and 6 funds keep the full or compact section; `comparisonPossible`; the stylesheet contract (no forced break before a fund or the comparison, with a negative control that the previous rule is caught; kept pieces are small; the named page declares four margin boxes; screen rules unchanged; the caption rule); the header and the server switch-off; the time zone (Sydney 10:08 pm, Kolkata, a date that crosses midnight, UTC label, negative control, rejected zone names); the picker rules (exact selections, never above 10 over all 25 ticks, negative control, disabled boxes); a static render of the panel (buttons, counter, 44 px class, disabled counts); recorded Chromium fills: the previous layout FAILS the blank-space rule, the new one passes. Updated: `nav2PdfLayout.test.ts` (new flow contract and judge, negative controls per rule; its real-render cases pass), `nav2PrintScale`, `nav2ReportFundCap`, `nav2StageThreeFixesContract`.

## NOT PERFORMED

* The PO's own desktop Chrome print dialog and a real production report (no production or DEV access): the proof is Chromium 151 headless shell on synthetic fixtures, whose print code is the same as the dialog's.
* Firefox and Safari: they ignore page margin boxes, so there the person still sees the browser's own header and footer (unchanged from the Monthly report; untick "Headers and footers").
* The picker was not rendered in a browser or on a phone (no DEV login): it is tested as static markup and pure rules; 44 px and focus ring come from the shared `Btn`.
* The Amplify production server was not run (no Chromium at runtime there by design: the person prints from their own browser).

## Found, not changed

`components/reports/ReportPrintFrame.tsx` (Monthly and Forecasting print) puts `--report-print-identity:"..."` in a React `<style>` text child. React escapes a quote in a server-rendered `<style>` to `&quot;`, which CSS does not decode, so on the real server the running-header identity is probably invalid and falls back to the default text. The Monthly check renders client-side so it did not see it. This document avoids the problem (`dangerouslySetInnerHTML` with sanitised text). Worth a separate small fix.

## Files

`components/reports/FundAnalyticsPrintDocument.tsx`, `FundPickPanel.tsx` (new), `FundAnalyticsReportClient.tsx`, `lib/reports/fundPicker.ts` (new), `app/globals.css` (`.fa-doc` block and `@page fa`), `app/(print)/reports/fund-analytics/print/page.tsx`, `lib/reports/fundAnalyticsPrintTitle.ts` (new), `lib/engines/date.ts`, `lib/engines/nav2/reportWording.ts`, `lib/config/nav2/printLayout.ts`, `lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer.ts`, `scripts/print/faPrintLayoutCheck.ts`, `printHarnessEntry.fa.jsx`, `faSsrHeaderProbe.ts`, `scripts/nav2_print_fixtures.ts` (`+longnames`), `scripts/nav2_pdf_layout_check.ts`, `scripts/nav2_pdf_layout_analyse.py`.
