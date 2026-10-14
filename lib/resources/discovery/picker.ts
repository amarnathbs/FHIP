// PO review F11 (06/10/2026) — pure logic behind the shared resource
// dropdown (components/ui/ResourceCombobox.tsx).
//
// The Context Mapping and Related Content screens only offered a search-only
// box. The PO asked for "the drop down option which help to select" listing
// all current resources. Everything that DECIDES something lives here, as pure
// functions, so it is unit-tested directly (the repo has no jsdom, so the
// component test renders markup with react-dom/server and drives this module's
// reducer for the keyboard behaviour):
//
//   - filtering: every typed word must match the title, the type label or the
//     status label (so "draft video" works), case-insensitive;
//   - BOUNDED rendering: at most PICKER_RENDER_LIMIT options are ever put in
//     the DOM, however many resources exist or however large a caller's
//     `limit` is. The rest is reported as a count ("N more, keep typing to
//     narrow") rather than rendered;
//   - the keyboard model (ARIA 1.2 combobox with a listbox popup): Arrow
//     keys, Home/End, Enter, Escape, Tab.

import { RELATABLE_LIST_CAP, formatContentTypeForPicker, formatStatusForPicker, type RelatableSearchResult } from '@/lib/resources/discovery/relatedAdmin';

export type PickerOption = RelatableSearchResult;

/** Hard cap on how many resources the list endpoint ever returns in one response. */
export const PICKER_LOAD_CAP = RELATABLE_LIST_CAP;

/** Hard cap on how many options are ever rendered at once. */
export const PICKER_RENDER_LIMIT = 50;

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Alphabetical by title (case-insensitive), id as a stable tie-break. */
export function sortPickerOptions(options: readonly PickerOption[]): PickerOption[] {
  return [...options].sort((a, b) => {
    const byTitle = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
  });
}

function haystack(option: PickerOption): string {
  return norm(`${option.title} ${formatContentTypeForPicker(option.content_type)} ${formatStatusForPicker(option.status)}`);
}

export interface FilterPickerResult {
  /** The options to render: never more than PICKER_RENDER_LIMIT. */
  visible: PickerOption[];
  /** How many options match (before the render bound). */
  matchCount: number;
  /** matchCount minus visible.length: what the "N more" line reports. */
  hiddenCount: number;
}

export function filterPickerOptions(
  options: readonly PickerOption[],
  query: string,
  opts: { excludeIds?: Iterable<string>; excludeContentTypes?: Iterable<string>; limit?: number } = {}
): FilterPickerResult {
  const excluded = new Set(opts.excludeIds ?? []);
  const excludedTypes = new Set(opts.excludeContentTypes ?? []);
  const tokens = norm(query).split(' ').filter(Boolean);
  // The caller may ask for FEWER than the bound, never more.
  const requested = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : PICKER_RENDER_LIMIT;
  const limit = Math.min(Math.max(1, requested), PICKER_RENDER_LIMIT);

  const matches = options.filter((o) => {
    if (excluded.has(o.id) || excludedTypes.has(o.content_type)) return false;
    if (tokens.length === 0) return true;
    const text = haystack(o);
    return tokens.every((t) => text.includes(t));
  });
  const visible = matches.slice(0, limit);
  return { visible, matchCount: matches.length, hiddenCount: matches.length - visible.length };
}

/** Wording of the "there is more" line (also used for the live region). */
export function hiddenCountMessage(hiddenCount: number): string {
  return `${hiddenCount} more, keep typing to narrow`;
}

export interface PickerSummaryInput {
  status: 'loading' | 'ready' | 'error' | 'forbidden';
  query: string;
  matchCount: number;
  hiddenCount: number;
  /** The server returned fewer rows than exist (the PICKER_LOAD_CAP applied). */
  truncated: boolean;
  total: number;
}

/** One sentence for the screen-reader live region and the visible status line. */
export function summarisePicker(input: PickerSummaryInput): string {
  if (input.status === 'loading') return 'Loading resources…';
  if (input.status === 'forbidden') return "You don't have permission to list resources.";
  if (input.status === 'error') return 'The resource list could not be loaded.';
  const q = input.query.trim();
  if (input.matchCount === 0) {
    return q ? `No resources match "${q}".` : 'There are no resources to choose from.';
  }
  const noun = input.matchCount === 1 ? 'resource' : 'resources';
  const base = q ? `${input.matchCount} ${noun} match "${q}".` : `${input.matchCount} ${noun}.`;
  const more = input.hiddenCount > 0 ? ` ${hiddenCountMessage(input.hiddenCount)}.` : '';
  const capped = input.truncated && !q ? ` Showing the ${PICKER_LOAD_CAP} most recently updated of ${input.total}; type to search all of them.` : '';
  return `${base}${more}${capped}`;
}

// ---------------------------------------------------------------------------
// Keyboard model — ARIA 1.2 combobox, "list autocomplete with manual
// selection": the input keeps DOM focus the whole time; aria-activedescendant
// points at the highlighted option; nothing is selected until Enter or click.
// ---------------------------------------------------------------------------

export interface ComboboxState {
  open: boolean;
  query: string;
  /** Index into the visible options, or -1 for none. */
  activeIndex: number;
}

export const INITIAL_COMBOBOX_STATE: ComboboxState = { open: false, query: '', activeIndex: -1 };

export type ComboboxEvent =
  | { type: 'input'; value: string }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'toggle' }
  | { type: 'hover'; index: number }
  | { type: 'key'; key: string };

export interface ComboboxResult {
  state: ComboboxState;
  /** Set when the event chose an option (index into the visible options). */
  selectIndex: number | null;
  /** The caller should call preventDefault() on the originating key event. */
  preventDefault: boolean;
}

function clampActive(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(index, -1), count - 1);
}

export function reduceCombobox(state: ComboboxState, event: ComboboxEvent, optionCount: number): ComboboxResult {
  const keep = (next: ComboboxState, extra: Partial<Omit<ComboboxResult, 'state'>> = {}): ComboboxResult => ({ state: next, selectIndex: null, preventDefault: false, ...extra });
  const active = clampActive(state.activeIndex, optionCount);

  switch (event.type) {
    case 'input':
      return keep({ open: true, query: event.value, activeIndex: -1 });
    case 'focus':
      return keep({ ...state, open: true, activeIndex: active });
    case 'blur':
      return keep({ ...state, open: false, activeIndex: -1 });
    case 'toggle':
      return keep({ ...state, open: !state.open, activeIndex: -1 });
    case 'hover':
      return keep({ ...state, activeIndex: clampActive(event.index, optionCount) });
    case 'key':
      break;
  }

  switch (event.key) {
    case 'ArrowDown': {
      if (optionCount === 0) return keep({ ...state, open: true, activeIndex: -1 }, { preventDefault: true });
      if (!state.open) return keep({ ...state, open: true, activeIndex: 0 }, { preventDefault: true });
      return keep({ ...state, activeIndex: active >= optionCount - 1 ? 0 : active + 1 }, { preventDefault: true });
    }
    case 'ArrowUp': {
      if (optionCount === 0) return keep({ ...state, open: true, activeIndex: -1 }, { preventDefault: true });
      if (!state.open) return keep({ ...state, open: true, activeIndex: optionCount - 1 }, { preventDefault: true });
      return keep({ ...state, activeIndex: active <= 0 ? optionCount - 1 : active - 1 }, { preventDefault: true });
    }
    case 'Home':
      // While the list is open Home/End move the highlight (the WAI-ARIA
      // pattern's optional behaviour); while closed they keep their normal
      // text-caret meaning.
      if (!state.open || optionCount === 0) return keep(state);
      return keep({ ...state, activeIndex: 0 }, { preventDefault: true });
    case 'End':
      if (!state.open || optionCount === 0) return keep(state);
      return keep({ ...state, activeIndex: optionCount - 1 }, { preventDefault: true });
    case 'Enter':
      if (state.open && active >= 0) return keep({ open: false, query: '', activeIndex: -1 }, { selectIndex: active, preventDefault: true });
      return keep(state, { preventDefault: state.open });
    case 'Escape':
      if (state.open) return keep({ ...state, open: false, activeIndex: -1 }, { preventDefault: true });
      if (state.query) return keep({ open: false, query: '', activeIndex: -1 }, { preventDefault: true });
      return keep(state);
    case 'Tab':
      // Never traps focus and never selects on Tab.
      return keep({ ...state, open: false, activeIndex: -1 });
    default:
      return keep(state);
  }
}
