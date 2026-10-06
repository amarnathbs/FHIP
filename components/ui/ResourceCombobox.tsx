'use client';

// PO review F11 (06/10/2026) — ONE reusable searchable dropdown for choosing a
// Resource. Replaces the search-only boxes on Context Mapping and Related
// Content ("it is better to give drop down option also with all the current
// resources").
//
//   - Lists ALL current resources (loaded once, capped at 500 by the API) and
//     filters as you type. Opens on focus, on the arrow button, and on
//     ArrowDown, so the whole list can be browsed without typing anything.
//   - ARIA 1.2 combobox with a listbox popup: the input has role="combobox",
//     aria-expanded, aria-controls, aria-activedescendant and
//     aria-autocomplete="list"; Arrow keys, Home/End, Enter and Escape work
//     (the keyboard model lives in lib/resources/discovery/picker.ts and is
//     unit-tested there).
//   - Every option shows the title plus its type and status as TEXT badges
//     (never colour alone), so an unpublished item is recognisable.
//   - BOUNDED: at most PICKER_RENDER_LIMIT (50) options are ever rendered; the
//     remainder is a count line ("N more, keep typing to narrow").
//   - Layout is mobile-first: title on its own line (wraps), badges beneath,
//     nothing wider than the control, so there is no horizontal overflow at 390px.
//   - Loading / error (with Retry) / forbidden / empty states are explicit.
//   - `excludeIds` hides already-linked items; `excludeId` hides the item
//     itself (also excluded server-side).

import { useEffect, useId, useRef, useState } from 'react';
import {
  INITIAL_COMBOBOX_STATE,
  PICKER_RENDER_LIMIT,
  filterPickerOptions,
  hiddenCountMessage,
  reduceCombobox,
  summarisePicker,
  type ComboboxState,
  type PickerOption,
} from '@/lib/resources/discovery/picker';
import { formatContentTypeForPicker, formatStatusForPicker } from '@/lib/resources/discovery/relatedAdmin';
import { useResourceOptions, type ResourceOptionsStatus } from '@/lib/resources/discovery/useResourceOptions';

export interface ResourceComboboxViewProps {
  id: string;
  label: string;
  helpText?: string;
  placeholder?: string;
  disabled?: boolean;
  status: ResourceOptionsStatus;
  state: ComboboxState;
  visible: PickerOption[];
  matchCount: number;
  hiddenCount: number;
  truncated: boolean;
  total: number;
  onInputChange?: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onToggle?: () => void;
  onOptionHover?: (index: number) => void;
  onOptionPick?: (index: number) => void;
  onRetry?: () => void;
}

const optionDomId = (id: string, optionId: string) => `${id}-opt-${optionId}`;

/** Presentational half — pure of hooks and fetching, so tests can render any state. */
export function ResourceComboboxView(props: ResourceComboboxViewProps) {
  const { id, label, helpText, placeholder, disabled, status, state, visible, matchCount, hiddenCount, truncated, total } = props;
  const listboxId = `${id}-listbox`;
  const helpId = `${id}-help`;
  const statusId = `${id}-status`;
  const ready = status === 'ready';
  const expanded = state.open && ready;
  const activeOption = expanded && state.activeIndex >= 0 ? visible[state.activeIndex] : undefined;
  const summary = summarisePicker({ status, query: state.query, matchCount, hiddenCount, truncated, total });

  return (
    <div className="w-full min-w-0">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      {helpText && (
        <p id={helpId} className="mb-1 text-xs text-muted">
          {helpText}
        </p>
      )}
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-activedescendant={activeOption ? optionDomId(id, activeOption.id) : undefined}
          aria-describedby={[helpText ? helpId : null, statusId].filter(Boolean).join(' ')}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={state.query}
          placeholder={placeholder ?? 'Choose or type to filter…'}
          onChange={(e) => props.onInputChange?.(e.target.value)}
          onKeyDown={props.onKeyDown}
          onFocus={props.onFocus}
          // Clicking an already-focused, closed box (after Escape) reopens it.
          onClick={props.onFocus}
          onBlur={props.onBlur}
          className="min-h-11 w-full rounded-compact border border-line bg-white py-2 pl-3 pr-12 text-sm text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-trust disabled:opacity-50"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label={expanded ? 'Hide the list of resources' : 'Show the list of resources'}
          aria-expanded={expanded}
          aria-controls={listboxId}
          onMouseDown={(e) => e.preventDefault()}
          onClick={props.onToggle}
          className="absolute inset-y-0 right-0 inline-flex min-h-11 w-11 items-center justify-center rounded-r-compact text-muted hover:text-ink disabled:opacity-50"
        >
          <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* The listbox is always in the DOM (aria-controls must resolve) but
            is only visible while expanded. */}
        <ul
          id={listboxId}
          role="listbox"
          aria-label={`${label} options`}
          hidden={!expanded}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto overflow-x-hidden rounded-compact border border-line bg-white py-1 shadow-lg"
        >
          {expanded &&
            visible.map((o, i) => {
              const active = i === state.activeIndex;
              return (
                <li
                  key={o.id}
                  id={optionDomId(id, o.id)}
                  role="option"
                  aria-selected={active}
                  // Mouse selection must not blur the input first.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => props.onOptionPick?.(i)}
                  onMouseMove={() => !active && props.onOptionHover?.(i)}
                  className={`flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 px-3 py-1.5 text-sm ${active ? 'bg-trust/10' : 'hover:bg-gray-50'}`}
                >
                  <span className="min-w-0 break-words font-medium text-ink">{o.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="inline-block whitespace-nowrap rounded-full bg-nav/5 px-2 py-0.5 font-medium text-nav">{formatContentTypeForPicker(o.content_type)}</span>
                    <span className="inline-block whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-700">{formatStatusForPicker(o.status)}</span>
                  </span>
                </li>
              );
            })}
          {expanded && hiddenCount > 0 && (
            <li role="presentation" className="px-3 py-2 text-xs text-muted">
              {hiddenCountMessage(hiddenCount)}
            </li>
          )}
        </ul>
      </div>

      <p id={statusId} role="status" aria-live="polite" className={`mt-1 text-xs ${status === 'error' || status === 'forbidden' ? 'text-risk' : 'text-muted'}`}>
        {summary}
      </p>
      {status === 'error' && (
        <button type="button" onClick={props.onRetry} className="min-h-11 text-sm font-semibold text-trust hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}

export interface ResourceComboboxProps {
  label: string;
  onSelect: (option: PickerOption) => void;
  helpText?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Restrict the list to one content type, e.g. 'video'. */
  contentType?: string;
  /** The item being edited: never offered (excluded by the server too). */
  excludeId?: string;
  /** Already-linked items: never offered. */
  excludeIds?: readonly string[];
  /** Content types never offered, e.g. ['video'] when linking a video to content. */
  excludeContentTypes?: readonly string[];
}

export function ResourceCombobox({ label, onSelect, helpText, placeholder, disabled, contentType, excludeId, excludeIds, excludeContentTypes }: ResourceComboboxProps) {
  const id = useId();
  const [state, setState] = useState<ComboboxState>(INITIAL_COMBOBOX_STATE);
  const { status, options, total, truncated, retry } = useResourceOptions({ contentType, excludeId, query: state.query });

  const { visible, matchCount, hiddenCount } = filterPickerOptions(options, state.query, { excludeIds, excludeContentTypes, limit: PICKER_RENDER_LIMIT });

  // Keep the highlighted option scrolled into view during keyboard navigation.
  const activeId = state.open && state.activeIndex >= 0 ? visible[state.activeIndex]?.id : undefined;
  const lastScrolled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeId || lastScrolled.current === activeId) return;
    lastScrolled.current = activeId;
    const el = document.getElementById(`${id}-opt-${activeId}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, id]);

  function apply(event: Parameters<typeof reduceCombobox>[1], originating?: React.KeyboardEvent) {
    const result = reduceCombobox(state, event, visible.length);
    setState(result.state);
    if (originating && result.preventDefault) originating.preventDefault();
    if (result.selectIndex !== null) {
      const chosen = visible[result.selectIndex];
      if (chosen) onSelect(chosen);
    }
  }

  return (
    <ResourceComboboxView
      id={id}
      label={label}
      helpText={helpText}
      placeholder={placeholder}
      disabled={disabled}
      status={status}
      state={state}
      visible={visible}
      matchCount={matchCount}
      hiddenCount={hiddenCount}
      truncated={truncated}
      total={total}
      onInputChange={(value) => apply({ type: 'input', value })}
      onKeyDown={(e) => apply({ type: 'key', key: e.key }, e)}
      onFocus={() => apply({ type: 'focus' })}
      onBlur={() => apply({ type: 'blur' })}
      onToggle={() => apply({ type: 'toggle' })}
      onOptionHover={(index) => apply({ type: 'hover', index })}
      onOptionPick={(index) => {
        const chosen = visible[index];
        setState({ open: false, query: '', activeIndex: -1 });
        if (chosen) onSelect(chosen);
      }}
      onRetry={retry}
    />
  );
}
