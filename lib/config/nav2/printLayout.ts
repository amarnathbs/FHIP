// NAV2 Fund analytics PDF: the page plan, in ONE place so the document, the layout judge and the tests agree.
//
// PO decision 19-10-2026 ("a lot of empty space in the report") replaced the 07-10-2026 rule that every fund and the comparison start a fresh page:
//   * the document FLOWS: summary, then each fund, then the comparison; no fund and no comparison forces a page break;
//   * a fund is a HEAD (name, price facts, chart) and a BODY of blocks (a heading with its table); each head, block, ranking and note is kept whole
//     (a chart or a table never splits), a page may end between them; the whole report uses the one-page-per-fund plan unless a piece cannot fit a
//     page (the export measures that), in which case it uses the two-page fallback (sheet A / sheet B, each on a fresh page);
//   * a comparison that cannot compare anything is one small block after the last fund; above COMPARISON_FULL_MAX_FUNDS the comparison switches to
//     the compact form (one ranking table and the most closely related pairs, with a plain note saying what is shown).
export type FundPagePlan = 1 | 2;
/** Preferred plan. The export measures the kept-together pieces of every fund in the browser and, if ANY does not fit a page, prints the WHOLE report with the two-page plan (never a mix). */
export const FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND: FundPagePlan = 1;
export const parsePagePlan = (v: string | null | undefined): FundPagePlan => (v === '2' ? 2 : 1);
export const FUND_ANALYTICS_MAX_COVER_PAGES = 2;
/** Up to this many funds the comparison page keeps its full form (a ranking table per category and horizon, every pair); above it, the compact form. */
export const COMPARISON_FULL_MAX_FUNDS = 5;
/** Compact comparison: the most closely related pairs shown, and the most rows the one ranking table shows. */
export const COMPARISON_TOP_PAIRS = 10;
export const COMPARISON_MAX_RANK_ROWS = 25;
