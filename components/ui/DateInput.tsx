'use client';

import { useId, useState, type InputHTMLAttributes } from 'react';
import { DATE_INPUT_HINT, DATE_INPUT_PLACEHOLDER, formatDateInput, parseDateInput } from '@/lib/engines/dateInput';

// A DAY-FIRST date field: a text input that shows DD-MM-YYYY (placeholder DATE_INPUT_PLACEHOLDER, help DATE_INPUT_HINT) and reads what
// is typed with parseDateInput(). It replaces <input type="date">, which renders in the BROWSER's locale (often month-first) and cannot
// follow the PO date rule (lib/engines/dateInput.ts). The value in and out is the ISO date-only string the API and the state already
// use ('' when empty or not yet a real date), so a screen changes only the tag, not its state or its handler:
//
//   <DateInput value={iso} onChange={(e) => setIso(e.target.value)} className="..." />
//
// onChange receives an event-shaped object whose target.value is the ISO date, or '' while the text is empty or not a real calendar date
// (the field is then marked invalid so nothing wrong is ever sent). min and max (ISO) are not native bounds on a text field: a date
// outside them is still passed on (the screen's own validation decides) but the field is marked invalid. Pass showHint where there is
// room for the one-line help under the field; the hint is always available to assistive technology and as the tooltip.

type Base = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'placeholder' | 'inputMode' | 'maxLength' | 'min' | 'max'>;

export interface DateInputProps extends Base {
  /** ISO date-only value (the wire format) or '' / null. */
  value: string | null | undefined;
  onChange?: (e: { target: { value: string } }) => void;
  /** Called on every keystroke: true while something is typed that is not a real day-first date. Screens that save a cleared date use it to stop the save. */
  onInvalidChange?: (invalid: boolean) => void;
  /** ISO bounds: outside them the field is marked invalid (the value is still passed on). */
  min?: string;
  max?: string;
  /**
   * What onChange reports while the text is not a real date: 'empty' (default, like a native date box) or 'raw' (the typed text itself, so a
   * save that sends it is refused by the server's own date check instead of silently clearing the date).
   */
  invalidAs?: 'empty' | 'raw';
  /** Show the one-line help ("Type the date as day-month-year, like 01-10-2026.") under the field. */
  showHint?: boolean;
}

/** What the box shows: the text being typed while it still means the current value, otherwise the current value, day first. Pure. */
export function dateInputShown(typed: string | null, iso: string | null | undefined): string {
  if (typed !== null && ((parseDateInput(typed) ?? '') === (iso ?? '') || typed === (iso ?? ''))) return typed;
  return formatDateInput(iso);
}

/** True when the text is not empty and is not a real day-first date inside the optional ISO bounds. Pure. */
export function dateInputInvalid(text: string, min?: string, max?: string): boolean {
  if (text.trim() === '') return false;
  const iso = parseDateInput(text);
  if (iso === null) return true;
  return (min !== undefined && min !== '' && iso < min) || (max !== undefined && max !== '' && iso > max);
}

export function DateInput({ value, onChange, onInvalidChange, min, max, showHint, invalidAs, className, 'aria-describedby': describedBy, id, ...rest }: DateInputProps) {
  const [typed, setTyped] = useState<string | null>(null);
  const generated = useId();
  const inputId = id ?? `date-${generated}`;
  const hintId = `${inputId}-datehint`;
  const shown = dateInputShown(typed, value);
  const invalid = dateInputInvalid(shown, min, max);
  return (
    <>
      <input
        {...rest}
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        value={shown}
        placeholder={DATE_INPUT_PLACEHOLDER}
        title={DATE_INPUT_HINT}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={[describedBy, hintId].filter(Boolean).join(' ')}
        className={`${className ?? ''}${invalid ? ' border-risk ring-1 ring-risk' : ''}`.trim() || undefined}
        onChange={(e) => {
          const text = e.target.value;
          setTyped(text);
          onChange?.({ target: { value: parseDateInput(text) ?? (invalidAs === 'raw' && text.trim() !== '' ? text : '') } });
          onInvalidChange?.(text.trim() !== '' && parseDateInput(text) === null);
        }}
      />
      <span id={hintId} className={showHint ? 'mt-1 block text-xs text-muted' : 'sr-only'}>
        {DATE_INPUT_HINT}
      </span>
    </>
  );
}
