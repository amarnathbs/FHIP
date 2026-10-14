// Global table layout (Product Owner 08-10-2026): the pure rules behind components/ui/DataTable.tsx and ClampText.tsx.
//
//   "tables make me scroll DOWN to find a table and then scroll RIGHT to reach columns ... cells wrap to 5+ lines because the
//    columns are squeezed while the table is still wider than the screen ... the Details/Action column is off screen"
//
// The rules, in one place so the component, the CSS in app/globals.css and the tests cannot drift apart:
//   1. A table fits the visible width on a normal desktop/laptop screen (>= 1024 px): the container never needs sideways scrolling
//      unless the columns genuinely cannot fit, and then the scroll stays INSIDE the table container (the page never scrolls sideways).
//   2. No cell wraps to more than two lines (CLAMP_DEFAULT_LINES). Longer text is clamped and a real "Show more" button reveals it.
//   3. Nothing is lost: the full text stays in the DOM, and is reachable by keyboard, mouse, touch and screen reader.
//   4. Numbers, dates, statuses and action buttons are never clamped or wrapped: they are single-line, compact cells.
//   5. Below 768 px the container scrolls sideways internally (keyboard focusable, labelled), with the first column and the action
//      column sticky so the row identity and its action are always on screen.
//   6. The container adds no vertical scroll area (no nested scroll trap) and, for a long secondary table, can show a jump link.

/** Lines a text cell may show before it is clamped. A Product Owner rule; raising it needs Product Owner approval. */
export const CLAMP_DEFAULT_LINES = 2;

/** Narrowest a clamped text cell may be squeezed to, in characters: below this a column becomes a tall unreadable sliver. */
export const CLAMP_DEFAULT_MIN_CH = 10;

/** A table with at least this many body rows that is not the primary content of its page offers a jump link past it. */
export const LONG_TABLE_ROWS = 12;

/** Kinds of cell. Everything except `text` and `clamp` is single-line and never truncated. */
export type CellKind = 'text' | 'clamp' | 'num' | 'date' | 'status' | 'action';

/** Kinds that must never wrap or be clamped: numbers, dates, statuses and action buttons (rule 4). */
export const NEVER_WRAP_KINDS: ReadonlyArray<CellKind> = ['num', 'date', 'status', 'action'];

export function neverWraps(kind: CellKind): boolean {
  return NEVER_WRAP_KINDS.includes(kind);
}

/** Class names for a cell of the given kind (the table-wide defaults live in app/globals.css under `.fhip-table`). */
export function cellClass(kind: CellKind, extra = ''): string {
  const base: Record<CellKind, string> = {
    text: '',
    clamp: 'fhip-cell-clamp',
    num: 'fhip-cell-nowrap text-right tabular-nums',
    date: 'fhip-cell-nowrap tabular-nums',
    status: 'fhip-cell-nowrap',
    action: 'fhip-cell-nowrap fhip-cell-action',
  };
  return [base[kind], extra].filter(Boolean).join(' ');
}

/** Header classes matching the body cell kind (numbers right-aligned like their column, never wrapped). */
export function headerClass(kind: CellKind, extra = ''): string {
  const base: Record<CellKind, string> = {
    text: '',
    clamp: '',
    num: 'fhip-cell-nowrap text-right',
    date: 'fhip-cell-nowrap',
    status: 'fhip-cell-nowrap',
    action: 'fhip-cell-nowrap fhip-cell-action',
  };
  return [base[kind], extra].filter(Boolean).join(' ');
}

/** True when the painted box is shorter than its content, i.e. the text really is cut. One pixel of rounding is tolerated. */
export function isClamped(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

/** Visible label of the expand control. */
export function clampToggleLabel(expanded: boolean): string {
  return expanded ? 'Show less' : 'Show more';
}

/** Whether to offer the jump link: a jump target was given, and the table is long enough for it to matter. */
export function shouldOfferJumpLink(rowCount: number | undefined, hasTarget: boolean): boolean {
  return hasTarget && (rowCount ?? 0) >= LONG_TABLE_ROWS;
}
