'use client';

// Two-line clamp for the text of one table cell, with an accessible "Show more" control.
//
// Product Owner rule 08-10-2026: no table cell may wrap to more than two lines, and nothing may be lost.
//   * The full text is ALWAYS in the DOM (CSS clamps what is painted, it does not remove text), so screen readers read all of it
//     and "find in page" finds it.
//   * When the text is actually cut, a real <button> appears next to it. It is reachable by Tab, works with Enter and Space, with
//     a mouse and with touch, and tells assistive technology whether the text is expanded (aria-expanded, aria-controls). A title
//     attribute alone would fail keyboard and touch users, so none is used.
//   * The control appears only when the text overflows, so short cells stay clean and cost no extra tab stop.
//
// Use it ONLY for plain descriptive text (a file name, a note, a list of names). Numbers, dates, statuses and action buttons are
// never clamped: give those cells the `num` / `date` / `status` / `action` kind of <Td> instead (components/ui/DataTable.tsx).
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CLAMP_DEFAULT_LINES, CLAMP_DEFAULT_MIN_CH, clampToggleLabel, isClamped } from '@/lib/ui/dataTable';

export interface ClampTextProps {
  children: ReactNode;
  /** Lines shown before clamping. The product rule is two; do not raise it without Product Owner approval. */
  lines?: number;
  /** Smallest width (in characters) the cell may be squeezed to, so a squeezed column never becomes a tall sliver. */
  minCh?: number;
  /** Optional upper bound (in characters) so one very long value cannot take the whole row. */
  maxCh?: number;
  className?: string;
}

/**
 * The "Show more" / "Show less" control: a native <button>, so Tab reaches it and Enter and Space (and a tap or a click) activate it,
 * with no key handling of its own. It reports the state (aria-expanded) and what it controls (aria-controls).
 */
export function ClampToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="fhip-clamp-toggle"
      aria-expanded={open}
      aria-controls={controls}
      // Inside a clickable row (a row that opens a detail panel) the toggle must only expand the text: the click and the
      // Enter / Space key must not also reach the row's own handler.
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {clampToggleLabel(open)}
    </button>
  );
}

export function ClampText({ children, lines = CLAMP_DEFAULT_LINES, minCh = CLAMP_DEFAULT_MIN_CH, maxCh, className = '' }: ClampTextProps) {
  const id = useId();
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    // Measured only while clamped: when expanded the box is as tall as its content, which says nothing about overflow.
    if (!el.classList.contains('fhip-clamp')) return;
    setOverflowing(isClamped(el.scrollHeight, el.clientHeight));
  }, []);

  useEffect(() => {
    measure();
    const el = textRef.current;
    if (!el) return undefined;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, children, open]);

  const style = {
    '--fhip-clamp-lines': lines,
    minWidth: `${minCh}ch`,
    ...(maxCh ? { maxWidth: `${maxCh}ch` } : {}),
  } as CSSProperties;

  const showControl = overflowing || open;
  return (
    <span className={`fhip-clamp-cell ${className}`}>
      <span ref={textRef} id={id} data-clamp-state={open ? 'expanded' : 'clamped'} className={open ? 'fhip-clamp-open' : 'fhip-clamp'} style={style}>
        {children}
      </span>
      {showControl ? <ClampToggle open={open} controls={id} onToggle={() => setOpen((v) => !v)} /> : null}
    </span>
  );
}

export default ClampText;
