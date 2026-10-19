# Print / Save as PDF file names (20-10-2026)

PO observation: every "Save as PDF" from the print flow proposed the same file name, "FHIP _ Financial Health.pdf". Chrome uses the page
`<title>` as the proposed name, and every print page carried the app-wide "FHIP | Financial Health" title.

## What changed

- `lib/reports/printDocumentTitle.ts` (pure): builds one title per print page from the report's own data. Month and date in words
  ("October 2026", "20 October 2026"), file-name safe (none of `\ / : * ? " < > |`, no trailing dot or space). A missing period falls
  back to the as-at date, then to the report name alone. Nothing is invented.
- `components/reports/PrintDocumentTitle.tsx` (client, renders nothing): sets `document.title` when the print page mounts.
- `lib/reports/printTab.ts` + `components/reports/PrintTabToolbar.tsx`: new optional `beforePrint` hook / `documentTitle` prop. The title is
  set again immediately before EVERY `window.print()` (the automatic `?print=1` one, 300 ms after mount, and the button), because the print
  dialog reads the title when it opens. A failing setter never blocks the dialog.
- Each page also exports a static `metadata.title` (server-rendered fallback, never the generic title), so the title is descriptive even
  before hydration.
- The named `@page report` margin boxes, `ReportPrintFrame` and the browser header/footer behaviour are untouched.

## Print pages and their new titles

| Print page (route) | Title format | Example | Data used |
|---|---|---|---|
| `app/(print)/reports/[id]/print` (Monthly Report and the other report types) | `FHIP <report type> - <Month Year>`, revision 2 or more adds ` (version N)` | `FHIP Monthly Report - October 2026`; revision: `FHIP Monthly Report - October 2026 (version 2)`; also `FHIP Goal Progress Report - March 2026`, `FHIP Financial Health Score Report - ...`, `FHIP Net Worth Report - ...` | `reports.report_type_code`, `report_month` (as_of_date if the month is missing), `version_number` |
| `app/(print)/reports/net-worth-statement/print` | `FHIP Net Worth Statement - <D Month YYYY>`; Family / All / entity views add the view: `FHIP Net Worth Statement - Family - <date>` | `FHIP Net Worth Statement - 20 October 2026`; `FHIP Net Worth Statement - Family - 20 October 2026`; `FHIP Net Worth Statement - Smith Family Trust - 20 October 2026` | `NetWorthStatementSet.asAt` (date-only, split without timezone shift), the view, the entity's name |
| `app/(print)/forecast/report/print` (Consolidated Forecast Report, including its variance section) | `FHIP Consolidated Forecast Report - <Month Year>` | `FHIP Consolidated Forecast Report - October 2026` | `ForecastReportData.generatedAt`, read in the reporting currency's home timezone (Sydney / Kolkata) so a report built just after midnight is not named for the previous month |
| `app/(print)/reports/fund-analytics/print` | NOT TOUCHED (owned by the Fund analytics print layout branch). It can reuse the same mechanism: render `<PrintDocumentTitle title=... />` and pass `documentTitle` to `PrintTabToolbar`; add a builder to `printDocumentTitle.ts`. | | |

Not present on this base (`origin/main` 7b26956): a separate Financial Activity print page, a Premium report print page, a stand-alone
Forecast Variance print page, or a bulk/resource print page. The only routes using `ReportPrintFrame` / `PrintTabToolbar` / `window.print` are
the four above (`window.print` is called only inside `lib/reports/printTab.ts`). If another branch adds a print page, the unit test
"the list covers every print page under app/(print)" fails until the page is added to the list with its own title builder.

## Tests (`tests/unit/printDocumentTitle.test.ts`, 25 tests)

- The exact title for sample data on every page, revisions, fallbacks (as-at date, name only), family/all/entity views, timezone edge
  (31 October 20:30 UTC is November in Kolkata, October at 10:30 UTC).
- File-name safety for all samples, including an entity name full of `/ : * ? " < > | \`.
- The controller calls `beforePrint` before the automatic and the manual print; a throwing setter does not stop printing.
- Every print page file (except Fund analytics) builds the title, renders `<PrintDocumentTitle>`, passes `documentTitle` to the toolbar, has a
  non-generic static title, and does not contain the generic title; the list of pages is checked against the directory.
- Negative controls: the old generic title and names with `:` or `/` or no `FHIP ` prefix fail the safety check; a controller without
  `beforePrint` shows the dialog the generic title; a synthetic old-style print page is flagged with at least four problems.

## Verification

- `tsc --noEmit` (NODE_OPTIONS=--max-old-space-size=8192): no errors in touched files. Two errors in untouched test files, both present on the base:
  `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (the known one) and `tests/unit/aiProductionProofPackPglite.test.ts(174,25)`.
- eslint on all touched files: clean.
- vitest: the new test plus `printTab`, `reportPrintLayoutRules`, `netWorthStatementUi`, `pageBackLinkGuard`, `reportSaveAsPdfFlow`,
  `aiContextualExplainUiContract`, `nav2FundAnalyticsRoutes`, `nav2StageThreeFixesContract`, `netWorthStatementParity`: 10 files, 233 tests, all pass.
  The full suite was not run, so `scripts/` was not rewritten.
- NOT PERFORMED: a headless-browser check that `document.title` is set at print time on the real pages. The print routes need a signed-in
  session and live data (no credentials available), and a headless browser cannot show Chrome's save dialog anyway. The ordering is
  proven at unit level (`beforePrint` runs before `print()`); a person should confirm once: open a report, press Print / Save as PDF, read the proposed name.
- No migrations, no secrets, no production access.
