// NAV2 Fund analytics PDF: the page plan, in ONE place so the document, the layout judge and the tests agree (PO decision 07-10-2026).
//
//   * the SUMMARY (title, intro, "Your funds at a glance", notes, how to read) flows and may take at most FUND_ANALYTICS_MAX_COVER_PAGES pages;
//   * EVERY FUND starts on a fresh page and takes exactly ONE page, or exactly TWO when any fund of the report cannot be set on one page
//     (compact two-column sheet, body text 8 pt or more); the plan is the same for every fund of a report;
//   * the comparison section is exactly ONE page, whatever the number of funds (above COMPARISON_FULL_MAX_FUNDS it switches to the compact
//     form: one ranking table and the most closely related pairs, with a plain note saying what is shown).
export type FundPagePlan = 1 | 2;
/** Preferred plan. The export measures the one-page fund sheets in the browser and, if ANY fund does not fit, prints the WHOLE report with the two-page plan (never a mix). */
export const FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND: FundPagePlan = 1;
export const parsePagePlan = (v: string | null | undefined): FundPagePlan => (v === '2' ? 2 : 1);
export const FUND_ANALYTICS_MAX_COVER_PAGES = 2;
/** Up to this many funds the comparison page keeps its full form (a ranking table per category and horizon, every pair); above it, the compact form. */
export const COMPARISON_FULL_MAX_FUNDS = 5;
/** Compact comparison: the most closely related pairs shown, and the most rows the one ranking table shows. */
export const COMPARISON_TOP_PAIRS = 10;
export const COMPARISON_MAX_RANK_ROWS = 25;
