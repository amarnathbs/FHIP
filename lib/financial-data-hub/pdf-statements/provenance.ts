/**
 * PDF statement routes: the PROVENANCE GUARD for a model's reading.
 *
 * A figure a model returns is not evidence unless the page prints it. The AI fallback of the CSV routes already applies this to the
 * balance anchors (`figureIsPrinted`); for a PDF the same rule is applied to EVERY drafted line, because a PDF is where a model is
 * most tempted to invent a plausible line (a fee, a repeated payment) or to compute a running balance the page does not print.
 *
 * An invented line is dropped from the draft with a visible warning code (so the person sees the reading was shortened, and the
 * reconciliation arithmetic then shows whether anything real is missing); a DROPPED line is caught by the same arithmetic. Neither
 * is ever silent. The text checked is the document's own extracted text (never sent anywhere by this function).
 */

import { figureIsPrinted } from '@/lib/aie/adapters/shared/reviewDraft';

export interface PrintedFilterResult<T> {
  kept: T[];
  /** 1-based positions in the input of every dropped item. */
  droppedPositions: number[];
}

/** Keep an item only when its amount is printed in the text. A null amount is not printed (an item with no amount is not a line). */
export function keepOnlyPrintedAmounts<T>(items: readonly T[], amountOf: (item: T) => number | null | undefined, documentText: string): PrintedFilterResult<T> {
  const kept: T[] = [];
  const droppedPositions: number[] = [];
  items.forEach((item, i) => {
    const amount = amountOf(item);
    if (amount !== null && amount !== undefined && figureIsPrinted(amount, documentText)) kept.push(item);
    else droppedPositions.push(i + 1);
  });
  return { kept, droppedPositions };
}

/** The visible warning code for dropped items, e.g. `ai_lines_not_printed_dropped_2` (a count, never a figure). */
export function droppedWarning(prefix: string, droppedPositions: readonly number[]): string | null {
  return droppedPositions.length === 0 ? null : `${prefix}_${droppedPositions.length}`;
}
