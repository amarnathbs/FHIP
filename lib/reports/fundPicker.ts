// The "Choose up to N funds" picker of the Fund analytics report: the selection rules as pure functions (the screen only renders them).
//
//   * the maximum is the server's own cap (`max`, 10 today): a fund is never added beyond it, here or by any button;
//   * "Select the N largest" restores the DEFAULT, the funds the server suggested (the largest by current value);
//   * "Clear all" empties the selection; the Generate button then stays off until at least one fund is ticked.
// No report content, API or idempotency logic is involved: this only decides which boxes are ticked.

export interface PickCandidate {
  instrumentId: string;
  schemeName: string;
  currentValue: number | null;
}

export interface PickState {
  max: number;
  heldFundCount: number;
  candidates: PickCandidate[];
  /** The ticked funds, in the order they were ticked. */
  chosen: string[];
  /** The server's suggestion (the largest by current value): what "Select the N largest" restores. */
  suggested: string[];
}

/** The largest funds by current value (a fund with no value last, ties kept in list order), at most `max`. Used only when the server gave no suggestion. */
export function largestIds(candidates: readonly PickCandidate[], max: number): string[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.currentValue ?? -Infinity) - (a.c.currentValue ?? -Infinity) || a.i - b.i)
    .slice(0, Math.max(0, max))
    .map((x) => x.c.instrumentId);
}

function known(pick: Pick<PickState, 'candidates'>, ids: readonly string[]): string[] {
  const ok = new Set(pick.candidates.map((c) => c.instrumentId));
  return [...new Set(ids)].filter((id) => ok.has(id));
}

/** Ticks exactly the suggested funds (the default), never more than `max`. */
export function selectLargest(pick: PickState): PickState {
  const base = pick.suggested.length > 0 ? known(pick, pick.suggested) : largestIds(pick.candidates, pick.max);
  return { ...pick, chosen: base.slice(0, pick.max) };
}

/** Unticks every fund. */
export function clearAll(pick: PickState): PickState {
  return { ...pick, chosen: [] };
}

/** One box ticked or unticked. Ticking is refused (nothing changes) when the maximum is reached, the fund is already ticked or is not in the list. */
export function toggleFund(pick: PickState, instrumentId: string, on: boolean): PickState {
  if (!on) return { ...pick, chosen: pick.chosen.filter((x) => x !== instrumentId) };
  if (pick.chosen.includes(instrumentId) || pick.chosen.length >= pick.max || !pick.candidates.some((c) => c.instrumentId === instrumentId)) return pick;
  return { ...pick, chosen: [...pick.chosen, instrumentId] };
}

/** A box beyond the maximum is disabled unless it is already ticked (so it can always be unticked). */
export function boxDisabled(pick: PickState, instrumentId: string): boolean {
  return !pick.chosen.includes(instrumentId) && pick.chosen.length >= pick.max;
}
