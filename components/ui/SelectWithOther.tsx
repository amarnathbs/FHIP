'use client';

import { useState } from 'react';

// A dropdown that reveals a conditional free-text input when "Other" is
// selected — the field's actual value IS that free text (not a separate
// "other" flag + text pair), which only works for fields with a permissive
// z.string() schema downstream (not a fixed Zod enum column feeding a real
// classification, e.g. housing_tenure's cohort-matching use — see
// lib/services/twinCohortMatching.ts). Reused across the onboarding
// wizard's employment status, household type, and marital status fields.

export interface SelectOption {
  value: string;
  label: string;
}

const OTHER_SENTINEL = '__other__';

export function SelectWithOther({
  id,
  label,
  value,
  onChange,
  options,
  otherPlaceholder = 'Please specify',
  required = false,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  otherPlaceholder?: string;
  required?: boolean;
  error?: string;
}) {
  const matchesKnownOption = value === '' || options.some((o) => o.value === value);
  // If the stored value doesn't match any known option and isn't empty, it's
  // a previously-entered "Other" free-text value — start in the Other branch
  // with that text pre-filled rather than silently discarding it.
  const [selection, setSelection] = useState(matchesKnownOption ? value : OTHER_SENTINEL);
  const [otherText, setOtherText] = useState(matchesKnownOption ? '' : value);

  const isOther = selection === OTHER_SENTINEL;
  const borderClass = error ? 'border-risk' : 'border-line';

  function handleSelectChange(next: string) {
    setSelection(next);
    onChange(next === OTHER_SENTINEL ? otherText : next);
  }

  function handleOtherTextChange(text: string) {
    setOtherText(text);
    onChange(text);
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm text-gray-600">
        {label}
        {required && <span className="text-risk"> *</span>}
      </label>
      <select
        id={id}
        value={selection}
        onChange={(e) => handleSelectChange(e.target.value)}
        className={`mt-1 w-full rounded border ${borderClass} px-3 py-2`}
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={OTHER_SENTINEL}>Other</option>
      </select>
      {isOther && (
        <input
          value={otherText}
          onChange={(e) => handleOtherTextChange(e.target.value)}
          placeholder={otherPlaceholder}
          className={`mt-2 w-full rounded border ${borderClass} px-3 py-2`}
        />
      )}
      {error && <p className="mt-1 text-xs text-risk">{error}</p>}
    </div>
  );
}
