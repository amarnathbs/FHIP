'use client';

import { useId, useState } from 'react';

export interface CorrectableFieldSpec {
  fieldName: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'enum';
  enumValues?: readonly string[];
}

/**
 * AIE15-ACT-02/A11Y-03: a typed correction input per declared field — never
 * a single freeform "fix it" box. Every input gets a real `<label>` +
 * `htmlFor` pairing (LR2 accessibility convention: no ARIA-only labelling
 * where a real `<label>` works) and inline, associated error text
 * (`aria-describedby`) rather than a toast that could be missed.
 */
export function CorrectionForm({ fields, onSubmit, submitting, error }: { fields: readonly CorrectableFieldSpec[]; onSubmit: (fieldName: string, rawValue: string) => void; submitting: boolean; error: string | null }) {
  const [selectedField, setSelectedField] = useState(fields[0]?.fieldName ?? '');
  const [value, setValue] = useState('');
  const inputId = useId();
  const errorId = useId();
  const active = fields.find((f) => f.fieldName === selectedField) ?? fields[0];

  if (!active) return null;

  return (
    <form
      className="mt-3 space-y-2 rounded border border-line bg-gray-50/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(active.fieldName, value);
      }}
    >
      {fields.length > 1 && (
        <div>
          <label htmlFor={`${inputId}-field`} className="block text-xs font-semibold text-ink">
            Which field are you correcting?
          </label>
          <select
            id={`${inputId}-field`}
            value={selectedField}
            onChange={(e) => {
              setSelectedField(e.target.value);
              setValue('');
            }}
            className="mt-1 min-h-11 w-full rounded border border-line px-2 text-sm"
          >
            {fields.map((f) => (
              <option key={f.fieldName} value={f.fieldName}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <label htmlFor={inputId} className="block text-xs font-semibold text-ink">
        {active.label}
      </label>
      {active.type === 'enum' ? (
        <select id={inputId} value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={error ? errorId : undefined} className="min-h-11 w-full rounded border border-line px-2 text-sm">
          <option value="" disabled>
            Choose {active.label.toLowerCase()}
          </option>
          {(active.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type={active.type === 'number' ? 'number' : active.type === 'date' ? 'date' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={error ? errorId : undefined}
          className="min-h-11 w-full rounded border border-line px-2 text-sm"
        />
      )}

      {error && (
        <p id={errorId} role="alert" className="text-xs text-risk">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting || !value.trim()} aria-disabled={submitting || !value.trim()} className="min-h-11 rounded bg-trust px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
        {submitting ? 'Saving…' : 'Save correction'}
      </button>
    </form>
  );
}
