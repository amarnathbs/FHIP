# Net Worth Statement: design note (PO request 16-10-2026)

Reports > **Net Worth Statement** (`/reports/net-worth-statement`). Three kinds of one-page A4 statement, selectable on the page and printable together.

## What it is

| Statement | Content |
|---|---|
| **Personal** | Assets (item, owner, amount) grouped Property / Cash / Investments / Retirement / Other with a subtotal per group and a total; Liabilities with a total; Personal net worth; a "By person" block (Self, Spouse/Partner, joint divided by the model's joint rule, counted once). |
| **Entity** (one per entity the model reports: SMSF, Family Trust, HUF, Company) | The entity's own assets, liabilities and net; the ownership share and the amount that goes into the family total (Company by ownership share, SMSF/Trust/HUF in full); an honest "not itemised yet" note where only a net value exists. |
| **Family (consolidated)** | Personal + each entity's contribution, line by line = family net worth; personal level by group; a reconciliation table to the Dashboard figures (headline, family level, previously reported net worth with the model's bridge lines). |
| **All statements** | Personal, each entity, Family: one page each (browser print / "Save as PDF"). |

Wording is observational; the footer is the standard report disclaimer (`PAGE1_DISCLAIMER`, "This report" -> "This statement"). Dates are day-first (dd/mm/yyyy AU, dd-mm-yyyy India), amounts whole units, owners shown as the app labels them (Self, Spouse/Partner, Joint), never ids or e-mails. The "Explain" affordance is not used: the Reports page uses it only on the interactive Monthly Report (`enableContextualExplain`), and the print path deliberately omits it.

## Free vs Premium

**Available to Free and Premium.** The statement only presents the person's own entered data and the Reports page already says browser printing is free ("In-app viewing and browser printing are available to everyone"; only server PDF/CSV export is Premium). So there is no plan check on the page, the print route or the loader (pinned by `tests/unit/netWorthStatementUi.test.ts` and `tests/unit/netWorthStatementParity.test.ts`), the PDF path is the browser's print dialog, and no server-side PDF export or render token was built (that would be a Premium Export Centre feature if the PO later wants it). Menu visibility follows the Reports capability like the Monthly Report.

## One source of truth

`lib/engines/netWorthStatement.ts` adds **no figure**. Every total, person split and entity contribution is read from `NetWorthLevels` (`lib/engines/netWorthLevels.ts`), the object the Dashboard builds once as `summary.netWorthLevels` and the Monthly Report carries in its Net Worth section. The loader (`lib/services/netWorthStatementData.ts`) calls `loadDashboardContext` (the Dashboard's own loader) and only adds row detail to *itemise* those totals:

* register lines from the same canonical snapshot (names, owner tag, native + reporting amount);
* `loadNetWorthLevels({ collect })`: one optional out-parameter added to the model's loader (2 lines) that hands back the exact rows the model used, so which SMSF loans are "already inside the fund balance" is the model's answer, not a second guess;
* holder name (`user_profiles.full_name`) and registered entities whose value was never entered.

**Where a row goes is decided by the model** (`classifyRow` runs `computeNetWorthLevels` on that one row with a probe amount), so the personal/entity rule is not copied. When `feat/personal-networth-excludes-smsf-fund-20261016` changes the rule, the statement follows with no edit.

**Parity is proven, not assumed.** `parity` compares the itemised lines with the model's totals (personal, each entity), personal + entity contributions with the family total, the Dashboard headline (`netWorthHeadline`) with the personal statement, and the model re-derived from the collected rows with the Dashboard's object. Any difference is shown as a red alert on screen (hidden in print) and in `parity.messages`; nothing is forced to agree. Optional fields the other branch adds (`smsfPossibleDoubleCount`, `bridge.personalParityOk`) are read through a tolerant accessor and shown/checked when present.

## Entity statements: today's data and the future shape

Entity-level asset/liability input does not exist yet (branch `feat/entity-level-assets-liabilities-design-20261016` is designing it; nothing is built here). The builder works on a stable input type:

```ts
interface EntityStatementInput {
  entityId: string;            // NetWorthEntityBlock.id, e.g. 'tag:smsf' or 'entity:<registry id>'
  kind: 'smsf' | 'family_trust' | 'huf' | 'company';
  name: string;
  assets: StatementSourceRow[];
  liabilities: StatementSourceRow[];
  net: number | null;          // the model's figure at 100%, never recomputed here
  source: 'entity_level_rows' | 'owner_tagged_rows' | 'registry_detail' | 'registry_summary';
}
```

Today it is assembled from: owner-tagged register rows (SMSF fund rows, legacy Family Trust / Company tags) and registered entities (Summary mode = one net value; Detailed mode = assets and liabilities totals, no line names exist in the model). A caller can pass `entityInputs` to override an entity with itemised rows; when entity-level rows ship (or the model emits them as `assets`/`liabilities` register rows owned by the entity, which already works), the entity page itemises automatically and the parity check proves the lines add to the model's entity totals.

Itemisation states shown honestly: `itemised` (asset and liability rows), `totals_only` (Detailed-mode registry entity), `net_only` ("Entity assets and liabilities are not itemised yet. Only the entity's net value has been entered...", with the register row(s) it was entered as). A registered entity with no value entered is **Not provided**, adds nothing to the family total, and is never zero.

## Personal basis (merged from origin/main, 17-10-2026)

The statement uses the personal-basis model as shipped (`lib/engines/netWorthBasis.ts`, `netWorthLevels.ts`): **no "if present" accessors remain.** It reads `levels.bridge.personalParityOk`, `levels.dataStatus.smsfPossibleDoubleCount`, `block.suppressedFundRecord` and the bridge line `smsf_fund_record_not_counted`; and the Dashboard's own personal figures (`summary.netWorth`, `totalAssetsCombined`, `totalLiabilities`) and history figure (`summary.netWorthBasis.history.netWorth`) are proven equal to the statement in `parity`.

* **Personal** = the model's personal level. The SMSF section's fund record (retirement row with `master_item_key = 'smsf'`, owned by a person) is entity-held: it is not a personal asset. Rows pass `masterItemKey` to the model, and placement is still asked of the model.
* **Fund record beside a fund-level row (owner smsf):** the record is **shown but not counted** (SMSF page list "Shown but not counted", a family note, the bridge line, and the model's double-count notice on the personal page). With no fund-level row the record is the fund's own balance and is counted once, in the SMSF block.
* **SMSF holdings:** when a fund is in Detailed mode its `smsf_holdings` (active rows, converted once to the reporting currency) itemise the SMSF page as assets. Liabilities are **"Not recorded at the fund"** (nothing is invented; a linked loan already inside the balance stays a note), and the net value counted stays the model's figure. A gap between holdings and net is stated, not hidden ("the holdings add to $503,000, so $370,000 of the difference is not itemised"). A failed read says "could not be read" on the page. The family page still adds the SMSF at its net.
* **PO production household as diagnosed:** fund record 503,000 (key smsf, owner self) + Other Retirement Assets 133,000 (owner smsf) + holdings 475,000 + 3,000 + 25,000 + an inactive personal loan 365,000 (never read): personal assets 2,260,298, liabilities 1,385,857, net **874,441**; SMSF net 133,000; family **1,007,441**; the history-basis figure 1,510,441 is bridged by `+503,000`. Tested through the real loaders in `tests/unit/netWorthStatementParity.test.ts`.

## Print tab behaviour (PO feedback 17-10-2026)

The Print button used to open a plain `target="_blank"` tab that stayed open after printing, with a back link that left two tabs showing the same information. Now (`lib/reports/printTab.ts`, `components/reports/PrintTabToolbar.tsx`, `components/reports/OpenPrintTabLink.tsx`):

* **Why closing needs a script-opened tab.** Browsers let a script close only a window that script opened (or a tab with one history entry). So the Print button opens the view with `window.open(url, 'fhip-print-<report>')` from the click handler (a user gesture, so not popup-blocked); a popup that is blocked falls back to this tab. The name also reuses one tab instead of piling up copies. `noopener` is deliberately not used on that call (it would return null, hiding a blocked popup, and some browsers then refuse to close); the destination is the app's own same-origin route and nothing is exchanged through `opener`, so there is no tab-nabbing exposure. The no-JavaScript fallback anchor keeps `rel="noopener"`. No BroadcastChannel/postMessage handshake is needed because the print tab closes itself.
* **Closing.** The print tab recognises itself as app-opened by its window name (or `window.opener`), prints once when opened with `print=1`, and closes itself shortly after `afterprint` (printed, saved as PDF or cancelled). A tab the app did not open (typed or bookmarked URL, middle-click) never auto-closes.
* **Fallback.** The toolbar's "Close this tab" button calls `window.close()`; if the browser refuses it says "You can close this tab now." (a `role="status"` live region) and moves focus to a "Back to <parent>" link. There is no "Back to Dashboard" on a print route.
* **Print CSS.** The toolbar is `no-print`, so no navigation control appears on paper or in a PDF.
* **One flow for all reports (PO 18-10-2026, "use the print flow"):** the Monthly Report and the Consolidated Forecasting Report now use the same single "Print / Save as PDF" button (see `docs/reports/REPORT_SAVE_AS_PDF_FLOW_2026-10-18.md`).
* **Shared by every person-facing report print route:** Net Worth Statement, Monthly Report (`/reports/[id]/print`, session only; the headless PDF renderer's token path never gets the toolbar) and the Forecasting report print route. Only the Net Worth Statement opens its print route in a new tab today; the Monthly Report and Forecasting report print in place, so their routes are only reached directly.
* **Back-link guard:** the statement print route is a bare page; it is now an allow-listed exemption (cap 10 -> 11) with an inventory row, because a back link there is exactly what left two tabs open.
* **Evidence:** real Chromium (Playwright): a script-opened tab closes itself on `afterprint`; a directly opened tab does not, and "Close this tab" shows the message and focuses the back link. Unit tests drive the pure controller with a fake window and scheduler (this repo has no jsdom).

## Hand oracles (PO household, AUD)

Personal level: assets 2,260,298 (Property 1,522,500, Cash 21,798, Investments 590,000, Other 126,000), liabilities 1,385,857, net **874,441**. By person (joint 50/50, counted once): Self 1,044,667.50, Spouse/Partner -170,226.50.

| Shape | Rows | Personal | SMSF | Family |
|---|---|---|---|---|
| A today (personal basis) | fund record 503,000 key smsf owner self + 133,000 owner smsf | 874,441 | 133,000 | 1,007,441 |
| A0 | a personal row named SMSF without the fund key + 133,000 owner smsf | 1,377,441 | 133,000 | 1,510,441 |
| B interim | the 503,000 personal row removed | 874,441 | 133,000 | 1,007,441 |
| C future | SMSF asset 503,000 + liability 370,000 itemised | 874,441 | 503,000 - 370,000 = 133,000 | 1,007,441 |

Company by share: 500,000 net at 40% -> 200,000 into the family total; Trust 300,000 recorded at 50% is counted in full.

## One page when printed

`.nws-root` rules in `app/globals.css` (scoped, nothing else changes): named `@page nws` (A4, 10mm/12mm margins), 8.5pt body, 8pt tables, one page break per statement, `thead` repeats, rows never split, totals are the *last rows* of their table (not a repeating `tfoot`), the table-wide `break-inside: avoid` of the report print rule is relaxed so a very large household flows onto a second/third page with repeated headings and totals at the end. The print route is bare (`app/(print)/reports/net-worth-statement/print`), the Print button opens it and calls `window.print()`.

Verified with Playwright/Chromium `page.pdf` (render to PDF, rasterised with PyMuPDF and inspected) on a synthetic fixture rendering the real components:

| Case | Pages |
|---|---|
| PO-style household, 18 items, all notes | 1 |
| 31 items + FX note + imported-not-in-net-worth note + Not provided + not-converted item | 1 |
| 118 assets + 28 liabilities | 3 (headings repeat, totals at the end) |
| All statements (Personal, SMSF, Company, Family) | 4 (one each) |
| SMSF itemised (shape C) | 1 |

Evidence files: `docs/reports/net_worth_statement_2026-10-16/` (PDFs and page images; evidence label: fixture-rendered, not DEV data). Mobile at 390px: no page-level horizontal scroll, tables scroll inside their labelled, focusable regions, first column sticky (the shared DataTable rules).

## Files

* `lib/engines/netWorthStatement.ts` (pure builder), `lib/services/netWorthStatementData.ts` (loader), `lib/services/netWorthLevelsData.ts` (+2 lines, `collect`)
* `components/reports/netWorthStatement/*`, `app/(app)/reports/net-worth-statement/page.tsx`, `app/(print)/reports/net-worth-statement/print/page.tsx`
* Menu: `lib/nav/appNavGroups.ts` (Reports group, after Monthly Report), `lib/nav/appNavCapability.ts` (REPORTS), card on `/reports`, `components/ui/AppShell.tsx` (the most specific Reports item is the current one, so Monthly Report does not light up on the statement page)
* No migration. No Admin surface touched (the Admin Architecture Standard clauses do not apply; the new routes are customer routes under the signed-in user's session and RLS).
