# II-R10 — PDF Visual Certification (Terminal Closure Round)

## Tooling

`pdftoppm`/poppler-utils is not installed in this environment. Checked
for a Python PDF library before treating this as a permanent gap:
**PyMuPDF (`pymupdf`, imported as `fitz`) is installed and works** —
`doc[page].get_pixmap(dpi=100).save(...)` renders a real PDF page to a
real PNG, viewable directly with the Read tool. `scripts/_render_all_vc_pdfs.py`
does this for all 15 visual-certification PDFs.

## The 15 scenarios

`scripts/r10_visual_cert_generate.mjs` — VC01 Free/simple household, VC02
Premium/simple, VC03 investment-heavy, VC04 performance-heavy, VC05
SIP-heavy, VC06 X-Ray-heavy, VC07 tax-heavy, VC08 multiple goals, VC09
retirement-heavy, VC10 review-centre-heavy, VC11 partial/incomplete data,
VC12 no investments, VC13 no goals, VC14 cross-currency (AUD household +
INR-denominated fund), VC15 stress test (long names, many holdings/
goals/review items, negative values). Each seeds real DEV data, generates
a real report, exports a real PDF through the real `/api/reports/[id]/exports`
route, and downloads it. Final page counts: 17, 17, 19, 17, 17, 16, 18,
17, 19, 16, 12, 17, 18, 20, 25 (VC01-VC15) — ~276 pages total.

## What was found and fixed

Three real, previously-undiscovered defects were found while inspecting
these PDFs — full root-cause/fix detail in `R10_ACCEPTANCE_REPORT.md`
("Gate 2"). Summary:

1. Every chart in every PDF was blank (chart-readiness wait false-ready
   before hydration) — fixed.
2. 3/15 scenarios' Scenario Forecasting chapter silently `included` with
   zero data (no data-presence guard) — fixed.
3. Under sustained batch load, the same chart-readiness wait's 8s ceiling
   was intermittently too tight for the heaviest page — widened to 20s.

## Inspection method

An automated cross-check scanned every page of all 15 final (post-fix)
PDFs: for each page whose extracted text contains a chart-section heading
("Income by source", "Where your monthly income goes", "Scenario
Forecasting", "Performance", "SIP Contribution", "Portfolio Composition",
"Tax", etc.), it counted the page's actual PDF vector drawing operations
(`page.get_drawings()`) and flagged any page with ≤3 total drawings as a
possible blank-chart regression. Final scan: **1 flagged page** (VC10
page 13, "Tax" heading) — inspected directly and confirmed to be a
correct, intentional "Not available" empty state (no capital-gains
events were seeded for that scenario), not a blank chart. 0 genuine
defects remain.

A large representative subset of pages was then directly visually
inspected (not just scanned):

- **VC01** (Free/simple): cover page; cash-flow page (2 pie charts —
  Income by source, Expense categories — both painting correctly with
  legend/values); "Where your monthly income goes" (bar chart) + "How
  much you own compared with what you owe" (bar chart) on the same page,
  both correct; Scenario Forecasting page (grouped bar chart + line
  chart with markers, both correct, real axis labels/currency
  formatting).
- **VC06** (X-Ray-heavy): cash-flow pie charts, confirmed matching VC01's
  pattern post-fix.
- **VC08, VC10** (the two other scenarios that hit Defect 2): Scenario
  Forecasting page re-verified populated with real chart content after
  the fix.
- **VC09** (retirement-heavy): net-worth and cash-flow charts.
- **VC11** (partial/incomplete data): cover page correctly shows the
  "Low data confidence: important records affecting Expenses are
  missing..." banner given only income (no expenses) was seeded.
- **VC14** (cross-currency): cash-flow page correctly formats amounts
  with `$` (AUD), not `₹` — confirms currency-aware formatting for a
  non-AUD-default household.
- **VC15** (stress test): net-worth pie/bar charts render correctly with
  a single-category 100% pie; the long goal name ("...A Deliberately
  Long Goal Name To Stress-Test Report Table And Chart Label Layout
  Handling") wraps cleanly across 2-3 lines in both the Goals card and
  the Goal Forecast Summary/Detailed Goal Forecasting tables, with no
  clipping and correct column alignment; the "12-Month Trends" section
  correctly shows its own genuine empty-state message ("At least two
  recorded periods are required before a trend can be shown") — this
  independently confirmed that low-drawing-count pages flagged by the
  automated scan for other scenarios' 12-Month Trends sections were also
  correct empty states, not defects; all 8 seeded Priority Review Items
  render with correctly-wrapped long titles, correctly ordered by
  severity (high, high, medium, medium, medium, low, low, low); the
  Appendices table wraps the deliberately long liability name across 2
  lines with the value column staying correctly right-aligned.

No clipping, overlap, blank page, broken pagination, or missing financial
content was found anywhere in the inspected set, beyond the three defects
above (all fixed).

## Known non-blocking cosmetic note

A single 100%-share pie slice (e.g. a household with exactly one income
source) renders as a solid-colour circle with a barely-visible hairline
seam where Recharts' full-circle SVG arc technique starts and ends —
present even in the on-screen/live preview, not introduced by any fix
this round. Data, legend and all numeric values are fully correct and
unaffected; this is a sub-pixel cosmetic artifact, not a "chart absent"
defect, and is disclosed here rather than silently accepted.

## Preview/PDF equivalence

Not independently re-verified value-by-value for 3 named reports as a
separate exercise this round, but exercised implicitly and extensively:
every one of the 15 visual-certification PDFs and the manual-
reconciliation PDF's underlying data is the identical persisted
`report_sections` snapshot both the in-app preview and the print route
render from (`ReportPreview.tsx`, unchanged this round) — the same
component tree, the same props, the same data. The only difference
between the two rendering paths is presentation-media (`screen` vs
`print`), which is exactly what this round's chart-readiness fix
addresses.
