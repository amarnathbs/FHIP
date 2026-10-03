'use client';

// Form feedback for the Market Index Data screens: per-field errors (red outline + red sentence, set by
// the field components), one summary at the top of the form whose entries focus the field, a banner for
// errors that belong to no field (INSIDE the open form, not only at the top of the page), and the first
// invalid field scrolled into view and focused (reduced-motion aware).
//
// All decisions are in benchmarkDataFormErrors.ts (pure, unit-tested); this file only holds state and
// touches the DOM.
import { useCallback, useEffect, useId, useState } from 'react';
import { revealScrollBehavior } from './benchmarkDataUiLogic';
import {
  buildSummary,
  firstInvalidKey,
  mapServerFields,
  serverFields,
  type FieldErrors,
  type FieldMap,
  type SummaryItem,
  type UnmappedField,
} from './benchmarkDataFormErrors';

export interface FormSpec {
  order: readonly string[];
  labels: Readonly<Record<string, string>>;
  map: FieldMap;
  dateKeys?: ReadonlySet<string>;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scroll the element into view (instant for reduced-motion users) and focus it without a second scroll. */
function reveal(el: HTMLElement | null): boolean {
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: revealScrollBehavior(prefersReducedMotion()) });
  el.focus({ preventScroll: true });
  return true;
}

/** The element carrying `data-form={formId}` (looked up in the document, after commit). */
function rootOf(formId: string): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(`[data-form="${formId}"]`);
}

export function focusFieldIn(root: HTMLElement | null, key: string | null): boolean {
  if (!root) return false;
  if (key) {
    const field = root.querySelector<HTMLElement>(`[data-field-key="${key}"]`);
    if (reveal(field)) return true;
  }
  return reveal(root.querySelector<HTMLElement>('[data-form-feedback]'));
}

export interface FormFeedbackState {
  errors: FieldErrors;
  items: SummaryItem[];
  banner: string | null;
  /** Put `data-form={formId}` on the element that wraps the form's fields and its feedback; focusing looks fields up inside it. */
  formId: string;
  /** Client validation result: show it, and focus the first invalid field. An empty object clears everything. */
  showClientErrors: (e: FieldErrors) => void;
  /** A failed submit: field errors when the server named fields, otherwise a banner inside the form. */
  showServerFailure: (body: Record<string, unknown> | null, message: string) => string | null;
  clear: () => void;
  focusField: (key: string | null) => void;
}

export function useFormFeedback(spec: FormSpec): FormFeedbackState {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [unmapped, setUnmapped] = useState<UnmappedField[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ n: number; key: string | null } | null>(null);
  const formId = useId();

  useEffect(() => {
    if (!focus) return;
    // After the commit that rendered the errors: the fields and the summary exist in the DOM now.
    focusFieldIn(rootOf(formId), focus.key);
  }, [focus, formId]);

  const ask = useCallback((key: string | null) => setFocus((f) => ({ n: (f?.n ?? 0) + 1, key })), []);

  const clear = useCallback(() => {
    setErrors({});
    setUnmapped([]);
    setBanner(null);
  }, []);

  const showClientErrors = useCallback(
    (e: FieldErrors) => {
      setErrors(e);
      setUnmapped([]);
      setBanner(null);
      const key = firstInvalidKey(e, spec.order);
      if (key) ask(key);
    },
    [spec.order, ask]
  );

  const showServerFailure = useCallback(
    (body: Record<string, unknown> | null, message: string): string | null => {
      const fields = serverFields(body);
      if (fields) {
        const m = mapServerFields(fields, spec.map, spec.dateKeys);
        setErrors(m.errors);
        setUnmapped(m.unmapped);
        setBanner(null);
        const key = firstInvalidKey(m.errors, spec.order);
        ask(key);
        return key;
      }
      setErrors({});
      setUnmapped([]);
      setBanner(message);
      ask(null);
      return null;
    },
    [spec.map, spec.dateKeys, spec.order, ask]
  );

  const items = buildSummary(errors, unmapped, spec.labels, spec.order);
  return {
    errors,
    items,
    banner,
    formId,
    showClientErrors,
    showServerFailure,
    clear,
    focusField: (key) => {
      focusFieldIn(rootOf(formId), key);
    },
  };
}

/** The summary box and the in-form banner. Render it at the top of the open form panel. */
export function FormFeedback({ fb, onNavigate }: { fb: FormFeedbackState; /** A form whose fields live on several steps: go to the field's step first. Defaults to focusing the field in place. */ onNavigate?: (key: string) => void }) {
  if (fb.items.length === 0 && !fb.banner) return null;
  return (
    <div className="mb-3 space-y-2">
      {fb.items.length > 0 ? (
        <div data-form-feedback role="alert" tabIndex={-1} className="rounded-compact border border-risk/40 bg-risk/5 px-3 py-2 text-sm">
          <p className="font-semibold text-risk">These fields need fixing:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {fb.items.map((it, i) => (
              <li key={`${it.key ?? 'other'}-${i}`}>
                {it.key ? (
                  <a
                    href={`#field-${it.key}`}
                    onClick={(e) => {
                      e.preventDefault();
                      if (onNavigate) onNavigate(it.key as string);
                      else fb.focusField(it.key);
                    }}
                    className="font-semibold text-risk underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust"
                  >
                    {it.label}
                  </a>
                ) : (
                  <span className="font-semibold text-ink">{it.label}</span>
                )}
                <span className="text-ink">: {it.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fb.banner ? (
        <div data-form-feedback role="alert" tabIndex={-1} className="rounded-compact border border-risk/40 bg-risk/5 px-3 py-2 text-sm text-ink">
          <p className="font-semibold text-risk">This could not be saved</p>
          <p className="mt-0.5">{fb.banner}</p>
        </div>
      ) : null}
    </div>
  );
}
