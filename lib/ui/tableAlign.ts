// App Review 2026-09-15 — Global Standard G2.
//
//   "In every table across every report and screen, numeric/amount columns
//    (values, targets, gaps, variances, currency amounts) must be
//    right-aligned. Text columns stay left-aligned. Apply at the shared
//    table/column component level so it cannot be missed on individual
//    pages."
//
// This app has no single shared <Table> component — 43 files hand-roll their
// own <table> markup — so "the shared component level" is implemented here,
// as the one place the rule is defined, plus a repo-wide guard test
// (tests/unit/g2AmountColumnAlignment.test.ts) that fails the build when a
// cell rendering money is not right-aligned. A shared constant alone can be
// forgotten; the constant PLUS the guard cannot.
//
// `tabular-nums` is included deliberately: right-aligning proportional
// figures still leaves digits ragged because '1' is narrower than '8'.
// Right-alignment is only actually legible with tabular figures, so the two
// travel together rather than being two things to remember.

/** Class for a <td>/amount cell in any table. */
export const NUM_CELL_CLASS = 'text-right tabular-nums';

/** Class for the matching <th>. Separate constant because header cells in
 *  this codebase frequently inherit `text-left` from a <thead>, which a bare
 *  `text-right` on the <td> alone would leave visually mismatched. */
export const NUM_HEADER_CLASS = 'text-right';

/** Convenience for the common `className={numCell('py-2 pr-3')}` shape. */
export function numCell(extra = ''): string {
  return extra ? `${extra} ${NUM_CELL_CLASS}` : NUM_CELL_CLASS;
}

export function numHeader(extra = ''): string {
  return extra ? `${extra} ${NUM_HEADER_CLASS}` : NUM_HEADER_CLASS;
}
