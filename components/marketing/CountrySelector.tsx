'use client';

// G2 — the anonymous, public-landing-page country selector (spec section
// 7). Deliberately dumb: it only ever POSTs a chosen code to
// /api/landing/country (or DELETEs to clear it), then asks the current
// route to re-render via router.refresh() so the server-rendered
// LandingCountryContext picks up the new cookie value on the very next
// request — no client-side duplication of the resolution logic, no full
// page reload/redirect, and the current path/query string is untouched
// throughout (spec section 7: "preserve intended navigation path/query
// string", "avoid a full redirect loop").
import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import styles from './CountrySelector.module.css';

export interface CountrySelectorOption {
  code: string;
  label: string;
}

// Matches the G1 registry's own selectable+active seed (migration 0122):
// AU/IN (FULL) plus GB/US/SG/AE (GENERIC). Presentation labels only -- this
// list is NOT a second registry; it exists purely so the <select> has
// human-readable option text without an extra request on every render. If
// the registry ever adds/retires a selectable country, this list is the one
// place to update alongside it.
export const COUNTRY_SELECTOR_OPTIONS: CountrySelectorOption[] = [
  { code: 'AU', label: 'Australia' },
  { code: 'IN', label: 'India' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'US', label: 'United States' },
  { code: 'SG', label: 'Singapore' },
  { code: 'AE', label: 'United Arab Emirates' },
];

const OTHER_VALUE = '__OTHER__';

export interface CountrySelectorProps {
  /** The currently active presentation country, or null if none is resolved yet (neutral prompt state). */
  activeCountry: string | null;
}

export function CountrySelector({ activeCountry }: CountrySelectorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  async function applySelection(code: string) {
    setError(null);
    try {
      const response = await fetch('/api/landing/country', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ country: code }),
      });
      if (!response.ok) {
        setError('Could not update your country preference. Please try again.');
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not update your country preference. Please try again.');
    }
  }

  async function clearSelection() {
    setError(null);
    try {
      await fetch('/api/landing/country', { method: 'DELETE' });
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reset your country preference. Please try again.');
    }
  }

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value === OTHER_VALUE) {
      void clearSelection();
      return;
    }
    void applySelection(value);
  }

  const selectValue = activeCountry ?? OTHER_VALUE;

  return (
    <div className={styles.wrap}>
      <span id={labelId} className={styles.label}>
        Country
      </span>
      <div style={{ position: 'relative' }}>
        <select
          aria-labelledby={labelId}
          aria-describedby={`${labelId}-hint`}
          className={styles.select}
          value={selectValue}
          disabled={isPending}
          onChange={onChange}
        >
          {!activeCountry && (
            <option value={OTHER_VALUE}>Choose your country&hellip;</option>
          )}
          {COUNTRY_SELECTOR_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
          <option value={OTHER_VALUE}>Other / not listed</option>
        </select>
        <span className={styles.chev} aria-hidden="true">
          &#9662;
        </span>
      </div>
      <p id={`${labelId}-hint`} className={styles.hint}>
        Choose your country to tailor examples and pricing information. This does not confirm your account or
        billing residence &mdash; you can confirm those separately.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--red, #dc2626)', fontSize: '0.7rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}
