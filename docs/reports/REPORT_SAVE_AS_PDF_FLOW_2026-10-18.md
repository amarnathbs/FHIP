# Save a report as a PDF: the print flow (PO decision 18-10-2026)

PO: "yes, use the print flow" for the Monthly Report's "Export PDF (premium)" button.

## Why
The server PDF export renders the report in headless Chromium. Amplify has no Chromium at runtime, so the export cannot work there
(it now answers with typed errors, commit 5883b95, instead of a bare 500). The browser's own print dialog can save any report as a PDF today.

## What a person sees
* **Monthly Report** (`/reports/[id]`): one button, **Print / Save as PDF**. It replaces both the old "Print" and "Export PDF (premium)".
* **Consolidated Forecasting Report** (`/forecast/report`): the same single button (it replaces "Export PDF" and the in-place print).
* **Net Worth Statement**: the same button (built earlier).
* The button opens the report's print view in its own tab from the click handler (`window.open`, named `fhip-print-*`), the print dialog opens
  by itself (`print=1`), and the tab closes itself afterwards; fallbacks (Close this tab, "You can close this tab now.", popup blocked) are in
  `lib/reports/printTab.ts` and `docs/reports/NET_WORTH_STATEMENT_DESIGN_2026-10-16.md`.
* Free on every plan: it only presents what the person can already view. The Reports page copy now says so ("Save as PDF ... free on every
  plan. Server-generated PDF and CSV downloads are not available yet.") and no label says "(premium)".

## What stays
* `POST /api/reports/[id]/exports` (with `lib/services/reportExportFailure.ts` typed errors) and `GET /api/forecast/report/export` stay in place and
  tested, **unused by these buttons for now**: reserved for a hosted renderer later. The Premium entitlement checks on those routes are unchanged.
* There was no CSV button in the UI; nothing changed for CSV.

## Tests
`tests/unit/reportSaveAsPdfFlow.test.ts` (one action, print route href with print=1, no `/exports` call, no "premium" wording, the opener is the
print-tab helper, a negative control that fails on the old buttons, the Reports page copy, routes and typed errors still present),
`tests/unit/printTab.test.ts` (closing behaviour), and the unchanged typed-error suites `reportReadExportTypedErrors` / `reportExportPdfFailures` /
`forecastReportExportEntitlement`.
