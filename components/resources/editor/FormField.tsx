'use client';

// Reusable labelled field wrapper — spec §84/§121: every field gets a
// visible/programmatic label, an optional description, and error
// association via aria-invalid + aria-describedby. No placeholder-only
// inputs anywhere in the editor use this without a real <label>.

import { useId } from 'react';

export function FieldWrap({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  trailing,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
          {label}
          {required && (
            <span className="text-risk" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </label>
        {trailing}
      </div>
      {hint && (
        <p id={hintId} className="mt-0.5 text-xs text-muted">
          {hint}
        </p>
      )}
      <div className="mt-1">{children}</div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-risk">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass = 'block w-full rounded-compact border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust';
const errorInputClass = 'block w-full rounded-compact border border-risk px-3 py-2 text-sm text-ink focus:border-risk focus:outline-none focus:ring-1 focus:ring-risk';

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  id,
  placeholder,
  trailing,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  maxLength?: number;
  id?: string;
  placeholder?: string;
  trailing?: React.ReactNode;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrap
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      required={required}
      trailing={maxLength ? <span className="text-xs text-muted">{value.length}/{maxLength}</span> : trailing}
    >
      <input
        id={fieldId}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null].filter(Boolean).join(' ') || undefined}
        className={error ? errorInputClass : inputClass}
      />
    </FieldWrap>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  rows = 3,
  id,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  maxLength?: number;
  rows?: number;
  id?: string;
  placeholder?: string;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrap label={label} htmlFor={fieldId} hint={hint} error={error} required={required} trailing={maxLength ? <span className="text-xs text-muted">{value.length}/{maxLength}</span> : undefined}>
      <textarea
        id={fieldId}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null].filter(Boolean).join(' ') || undefined}
        className={error ? errorInputClass : inputClass}
      />
    </FieldWrap>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  required,
  id,
  allowBlank,
  blankLabel = 'Select…',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  error?: string;
  required?: boolean;
  id?: string;
  allowBlank?: boolean;
  blankLabel?: string;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldWrap label={label} htmlFor={fieldId} hint={hint} error={error} required={required}>
      <select
        id={fieldId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null].filter(Boolean).join(' ') || undefined}
        className={error ? errorInputClass : inputClass}
      >
        {allowBlank && <option value="">{blankLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldWrap>
  );
}

export function CheckboxField({ label, checked, onChange, hint, id }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; id?: string }) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div>
      <label htmlFor={fieldId} className="flex items-center gap-2 text-sm font-medium text-ink">
        <input id={fieldId} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-line text-trust focus:ring-trust" />
        {label}
      </label>
      {hint && <p className="mt-0.5 pl-6 text-xs text-muted">{hint}</p>}
    </div>
  );
}
