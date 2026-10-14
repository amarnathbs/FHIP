# Global table layout (Product Owner review 08-10-2026)

Branch `feat/global-table-layout-20261008` (from `origin/main`). Nothing pushed, merged, applied to a database or deployed.

## 1. What the Product Owner asked for

For every table in the app (customer and Admin):

1. The table fits the visible width on a normal desktop or laptop screen (1024 px and up), so no sideways scrolling is needed to reach a column or an action.
2. No cell wraps to more than two lines.
3. No information is lost: the full text is reachable by hover, keyboard focus, touch and screen reader (not a `title` attribute alone).
4. Numbers, dates, statuses and action buttons are never truncated or clamped. A date or a date range is never broken at its hyphens; a range may break only between the two dates.
5. Below 768 px the table scrolls inside its own labelled, keyboard-focusable container with the first column and the action column sticky; the page itself never scrolls sideways.
6. Tall tables add no nested vertical scroll trap; a long secondary table can offer a visible jump link.
7. Follow-up example (Market Index Data > Entitlements): a table text size one step below body text (13 px, never below 12 px) and tighter padding are allowed, as are short column headers with accessible full names, and low-priority long text clamps to two lines.

## 2. Inventory (origin/main, before this change)

Scan of `app/` and `components/` (`*.tsx`), comments excluded.

| Measure | Count |
|---|---|
| Raw `<table>` elements | 109 in 68 files |
| `ScrollTable` call sites (Admin Market Index Data helper, itself one raw table) | 13 in 9 files |
| Grid-as-table (`role="table"`, `role="grid"`, CSS-grid imitation) | 0 found (the Admin card-below-1280 table of the other branch uses explicit `role="table"`, see section 7) |
| Tables with a fixed `min-w-[Npx]` | 24 |
| Tables with 8 or more columns | 14 |

Grouped by pattern:

| Pattern | Raw tables | What was wrong |
|---|---|---|
| Plain `overflow-x-auto` wrapper around the table | 51 | scrolls sideways, wrapper not labelled or focusable, cells squeezed to 5+ lines first |
| Bare table, no wrapper | 44 | wider than the content area pushes the page sideways |
| `ScrollRegion` (`max-h-72 overflow-auto`) | 7 | nested vertical scroll trap, sticky header only works inside it |
| Bounded-height box (`max-h-... overflow-auto`) | 7 | nested vertical plus horizontal scroll; the horizontal bar sits under the last row |
| `ScrollTable` helper (`min-w-[...]`) | 13 call sites | a fixed minimum width forced sideways scrolling at laptop widths |

Grouped by audience: customer 58, Admin 31 (including Resources Admin lists), report/print 20.

Worst offenders (columns = header cells, longest cells noted):

| Table | Columns | Fixed min width | Notes |
|---|---|---|---|
| `components/reports/IndiaMfInvestmentReportSection.tsx` | 16 | 1000 px | PO-specified India MF report, prints on its own landscape page |
| `components/investment-intelligence/HoldingsTable.tsx` | 14 | 960 px | PO fixed the columns to his own workbook; scheme names truncated to 28 characters with a `title`; nested bounded scroll |
| `app/(app)/forecast/variance/page.tsx` | 11 | 900 px | |
| `components/resources/admin/ResourceContentTable.tsx` | 10 | none | already hides low-priority columns below `sm`/`xl` |
| `components/resources/video/VideoListClient.tsx` | 10 | none | same pattern |
| `components/retirement/RetirementStatementHistory.tsx` (2 tables) | 9 | 860 / 720 px | |
| `components/admin/benchmarkData/JobsTab.tsx` Recent import jobs | 10 | 860 px | the PO's first example: dates wrapped to 5 lines, Details off screen |
| `components/admin/benchmarkData/EntitlementsTab.tsx` per benchmark | 13 | 980 px | the PO's second example: Term broke into 8 lines, Evidence off screen |
| `components/admin/PromoCodesClient.tsx` Codes | 8 | none | 12-line note cells at 1024 px |

## 3. The shared mechanism

| File | Role |
|---|---|
| `components/ui/DataTable.tsx` | `DataTable` (the one place a real `<table>` is written), `DataTh`, `DataTd`, `NoWrap`, `DateRange`, `DateTimeText`. Server-safe. |
| `components/ui/ClampText.tsx` | `ClampText` (two-line clamp that measures itself) and `ClampToggle` (the "Show more" button). Client component. |
| `lib/ui/dataTable.ts` | The rules as constants and pure functions (two lines, cell kinds, never-wrap kinds, jump-link threshold, clamp test). |
| `app/globals.css` (`.fhip-table*`, `.fhip-clamp*`) | Layout: region, 13 px table text, nowrap kinds, clamp, sticky columns below 768 px, print. |
| `tailwind.config.ts` | scans `lib/ui` so the cell classes defined there are not purged. |

Behaviour:

* **Fit.** `DataTable` renders one labelled region (`role="region"`, `aria-label`, `tabIndex=0`) around the real table. The table is `width: 100%` and shrinks to it; sideways scrolling happens only inside the region when the columns genuinely cannot fit, never on the page. `position: relative` on the region stops a visually hidden caption from widening the page (this was a cause of a 447 px page at 390 px in the first run).
* **Two lines, nothing lost.** `kind="clamp"` cells use `ClampText`: CSS clamps to two lines (`-webkit-line-clamp`), the full text stays in the DOM, and when the browser measures the text as really cut a real `<button>` "Show more" appears (`aria-expanded`, `aria-controls`), operable by Tab, Enter, Space, click and touch. A short cell shows no control.
* **Never clamped.** `kind="num" | "date" | "status" | "action"` are single-line (`fhip-cell-nowrap`); numbers also right-aligned with tabular figures (the existing G2 rule travels with them). Raw cells that already use `tabular-nums` or `text-right` get the same nowrap by CSS, so the 100+ migrated tables get it without editing every cell.
* **Dates.** `NoWrap`, `DateRange` (breaks only after " to ") and `DateTimeText` (breaks only between the date and the time) keep each date whole. The text is unchanged, so the dd-mm-yyyy wording rule is untouched. 23 raw date cells in other tables received `whitespace-nowrap`.
* **Narrow screens.** Below 768 px the first column and every `fhip-cell-action` column are sticky inside the region.
* **No vertical trap.** The region has no max-height. Where an existing bounded list was kept (statement line reviews, Holdings) the region itself is the only scroller, so the header can stay sticky.
* **Jump link.** `jumpTo` plus `rowCount` (12 or more rows) shows a visible link past a long secondary table.
* **Smaller table text.** `.fhip-table` is 13 px (0.8125rem); utility classes on a table still win.
* **Print.** Region overflow and sticky are switched off under `@media print`.

Adoption by `fix/market-index-data-layout-20261008` is a one-line change per table (section 7).

## 4. Migration (all tables; semantics unchanged)

* Mechanical: a codemod replaced every `<table ...>` with `<DataTable label="..." ...>` and `</table>` with `</DataTable>`, kept every attribute (class, test id, aria label, caption), absorbed a plain `overflow-x-auto` wrapper into `wrapperClassName`, and set the region label from the table's own `aria-label`, `<caption>` or nearest heading (44 labels written by hand). `text-sm` was removed from table classes so the 13 px default applies; `text-xs` tables are unchanged. Raw `<thead>/<tr>/<th>/<td>` are untouched, so the G2 amount-alignment guard (`tests/unit/g2AmountColumnAlignment.test.ts`) and every capability check, data load, sort and page behave as before. `git diff -w` shows the real change: tag swap, import, label.
* `ScrollTable` (Admin Market Index Data) now delegates to `DataTable`, so all 13 call sites got the mechanism at once; its `minWidth` argument is accepted and ignored.
* The seven `ScrollRegion` boxes (Planning Benchmarks) and six bounded-height boxes were merged into the table's own region (one scroller instead of two nested).
* Hand-tuned for the PO's examples (section 5): Recent import jobs, Entitlements, Promo Codes, Holdings, Reports list.
* Fixed on the way (found by axe): report status badges (white on #B7791F and #9CA3AF, below 4.5:1), Admin chip tone colours (the same colours the other branch uses), the Holdings row that was itself `role="button"` and contained a link (nested interactive control).

## 5. Verification

Evidence labels: UNIT-TESTED = vitest; BROWSER-HARNESS = real Chromium rendering of the real components with fetch answered from fixtures (`npm run test:a11y:tables`, `scripts/a11y/dataTableCheck.mjs`), no login, no database, no dev server; DEV-browser-verified = not done (see below).

**DEV-browser-verified: not done.** No authenticated DEV session was available and a password is never typed or requested. The harness renders the production components inside the same width constraints as the Admin shell (sidebar 248 px, content padding, `max-w-6xl`), so the measured table widths are the real ones at those viewports.

BROWSER-HARNESS, widths 1280, 1024, 768 and 390; every check passed (`ALL CHECKS PASSED`):

| Page (real component) | Fits at 1280 | Fits at 1024 | Max lines per cell | Page sideways scroll | axe WCAG 2.0/2.1/2.2 A and AA |
|---|---|---|---|---|---|
| Market Index Data > Recent import jobs (`JobsTab`) | yes | yes | 2 | none at all four widths | 0 violations |
| Market Index Data > Entitlements, two benchmarks (`EntitlementsTab`) | yes | yes | 2 | none | 0 |
| Admin > Promo Codes: Codes and Audit trail (`PromoCodesClient`) | yes | yes | 2 | none | 0 |
| Customer > Reports list (`ReportHistoryTable`) | yes | yes | 1 | none | 0 |
| Customer > Investment Intelligence Holdings (`HoldingsTable`) | no, scrolls inside its region | no, scrolls inside its region | 2 | none | 0 |
| Market Index Data > Mappings (held schemes, Factsheet sources) | reported, not counted (other branch) | reported, not counted | | none | |

Also checked in the browser at 1024: the clamped text is complete in the DOM before expanding; Tab reaches "Show more"; Enter expands (`aria-expanded=true`, label "Show less", `data-clamp-state=expanded`); Space collapses; no date is broken across lines; at 390 the first column is `position: sticky`; every region is labelled and focusable.

UNIT-TESTED: `tests/unit/dataTable.test.ts` (region role/label/tabindex, attribute pass-through, nowrap kinds, clamp markup and defaults, toggle semantics, date helpers, jump link) and `tests/unit/dataTableGuard.test.ts` (section 6). `tests/unit/heldSchemesLayout.test.ts` was updated for the delegation of `ScrollTable`.

Screenshots (1280, 1024, 390): `docs/ux/global-table-layout-2026-10-08/`.

Suites: full unit run on the final commit, 676 files passed and 33 failed. 23 of the 33 are Windows temp-file load flakes (`ENOENT` in the vitest temp folder under load; all 23 pass when re-run in groups of four) and 10 fail identically on a clean `origin/main` extraction (`adminAnalyticsPhaseAMeRoute`, `aiResidualClosureFailClosed`, `countryGateAccessMatrix`, `iiNetWorthNavRemarkPublishFlow`, `lr1UploadSecurityRawFileLifecycle`, `m12cServerOnlySecretBoundary`, `resourcesImportR1_7LiveDev`, `resourcesP0ContentR1_7C`, `resourcesP0ContentR1_7CLiveDev`, `resourcesR1_1`). `tsc --noEmit` reports one error in `tests/unit/canonicalCertResidueAllSql.test.ts` (a file this change does not touch). ESLint: no new finding; the 4 `set-state-in-effect` errors (AiExtractionReviewPanel, TransactionDetailModal) and 2 `<img>` warnings are identical on `origin/main`.

## 6. Guard

`tests/unit/dataTableGuard.test.ts` scans `app/` and `components/`: a raw `<table` outside `components/ui/DataTable.tsx` fails, as does any `<DataTable>` without a `label`. The allow-list has two entries, each with a reason and a staleness check (`components/admin/benchmarkData/responsiveTable.tsx` is optional because it exists only on the other branch). Negative controls: a virtual new file with a raw table, a real migrated file turned back into `<table`, and an unlabelled `<DataTable` are each shown to fail; comments mentioning `<table>` are shown not to be false alarms. It also pins the CSS contract (scroll region, nowrap, clamp lines, sticky only below 768 px, 13 px text, print, Tailwind scanning `lib/ui`).

## 7. Coordination with the Market Index Data Mappings chip task

Branch `fix/market-index-data-layout-20261008` (worktree `keen-germain-9ad5e3`, commit `6155577`) builds `components/admin/benchmarkData/responsiveTable.tsx`, an `RTable` that is a real table from 1280 px and cards below it, for `MappingsTab`, `FactsheetSourcesPanel` and `HeldSchemesTable`. This branch did not touch those three files or `benchmarkDataUiLogic` summaries; it touched `ui.tsx` (ScrollTable, Th, Td; identical chip colour hunk) and `heldSchemesLayout.test.ts` (one assertion). Expected merge friction: that test file (take the other branch's rewrite) and `ui.tsx` (disjoint hunks except the identical tone colours).

How that work can adopt the mechanism: replace `RTable` by `<DataTable label=...>` and cells by `DataTd kind="clamp" | "action"`; the held-schemes name and benchmark sentence become `kind="clamp"` (two lines, accessible "Show more" instead of a `title`), the Action cell `kind="action"`. Measured on the base `ScrollTable` markup (so with only the default mechanism, nothing tuned): held schemes need 1469 px and Factsheet sources 880 px at 1024 and 1280, which is why those tables still need that branch's compaction; this is reported, not counted as a failure. Its `RTable` falls back to cards below 1280 px, whereas the PO's requirement here is that tables fit from 1024 px, so the adoption should lower that breakpoint to `lg`.

## 8. What was not migrated or cannot fit at 1024

Left as an allow-listed file: none outside the mechanism itself (the other branch's `responsiveTable.tsx` is allow-listed until it adopts `DataTable`).

Cannot fit 1024 px (content width about 680 px next to the 248 px sidebar), so they scroll inside their labelled, focusable region (page never scrolls sideways):

* `HoldingsTable` (measured): 15 columns, 1305 px; the PO fixed the column set to his workbook. A "Ledger" button column was added so the keyboard has a real opener.
* Tables that kept an authored `min-w-[...]` of 700 px or more and were not tuned or measured: Forecast Variance (900), Forecast Report "against actual" (900), "Scenario comparison" (700), "Forecast assumptions" (700), Scheme performance (720), Realised gains (720), Retirement statement activity (860) and holdings (720), India MF investment report (1000, prints landscape).
* Tables with a retained `min-w` of 420 to 640 px should fit at 1024 but were not measured.

Not browser-verified at all (only rendered through the shared CSS): the other roughly 90 migrated tables, including the Resources Admin lists and the report preview tables. They get the region, nowrap kinds, 13 px text, date nowrap and the page-never-scrolls guarantee from the mechanism, but no per-table fit or two-line measurement was made.

Known judgement calls to confirm with the Product Owner: Promo Codes "Address-bound" Yes/No column became a secondary "Address-bound" line under Status (a "No" is now shown by absence); Recent import jobs and Entitlements each show one record as two rows (figures and dates first, long text and actions second) so the first row fits 1024 px; the Corrections header shows "Corr." with the full word for assistive technology.

## 9. Admin Architecture Standard compliance (AGENTS.md)

* Admin capabilities affected: none introduced, changed or removed. This is presentation only. No route, API, RPC, RLS policy, role or navigation entry was touched, and no capability check was moved (each migrated table keeps the conditional that decides whether its actions render).
* Clauses that apply: section 2 and section 4 (a control that is hidden stays hidden: Approve, Revoke, Open and Disable render under the same conditions as before; the Entitlements and Jobs rows were restructured, not their `acts.canApprove` / `acts.canRevoke` / capability gates); section 14 (no hidden scope expansion: no unrelated Admin behaviour changed; the three files owned by `fix/market-index-data-layout-20261008` were left alone); section 18 (back navigation untouched; `pageBackLinkGuard` passes).
* Tests: `tests/unit/benchmarkDataEntitlementReveal.test.ts`, `benchmarkDataFormErrors.test.ts`, `benchmarkDataClientStates.test.ts`, the Planning Benchmark UI suites, `tests/unit/pageBackLinkGuard.test.ts`, the date-format guards and `g2AmountColumnAlignment.test.ts` pass on the final commit (full run above); the new guard and component tests are in section 5 and section 6.
* Exceptions requested under section 16: none.

## 10. Merge with origin/main 1acb916 (Entitlement Edit, migration 0280, promo release)

Merged with a normal merge commit (no rebase). Conflicts and how they were resolved:

* `EntitlementsTab.tsx`: every Edit behaviour was kept (current and history split, the open-revision badge, Edit, Edit (needs approval), Edit revision, Review / Reject / Cancel revision, Revoke, History, Show history, the History panel, the capability gates, test ids and the accessible names such as "Edit revision of record a1b2c3"). A record is up to three rows of one row group: (1) status, the open-revision badge ("Revision pending", full text in its title), six compact rights, term, data range; (2) kind, after expiry and evidence as clamped text with the accessible "Show more"; (3) the actions as one wrapping row of compact buttons inside a labelled group ("Actions for record a1b2c3"). A compact button is 32 px high on a mouse screen and 44 px on a touch screen; the Show more control is 44 px on touch too.
* `PromoCodesClient.tsx`, `PremiumEntitlementsClient.tsx`: took the release's markup, re-applied the `DataTable` migration (the release's own region labels became the table labels) and the Promo compaction; the release's new `PromoSetupCheck` table was migrated too.
* No migration is introduced by this branch (`git diff origin/main HEAD -- supabase` is empty).

Re-verification after the merge (browser harness, Entitlements with an open revision, a draft, Show history ticked and the History panel open): fits at 1280 (900 of 900) and at 1024 (644 of 644), at most 2 lines per cell, tallest record 177 px at 1024, every expected button present once with its accessible name, axe 0 violations, no page-level scroll at 1280, 1024, 768 and 390. Touch emulation (pointer: coarse, 390 px): smallest action button 44 px, Show more 44 px.
