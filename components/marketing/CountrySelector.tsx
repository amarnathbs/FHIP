'use client';

// G2 — the anonymous, public-landing-page country selector (spec section
// 7; PO clarification 2026-09-02 section 1). Exactly THREE top-level
// experience choices: Australia, India, Global — 'Global' is a first-class,
// always-selectable option, not merely a fallback shown when nothing else
// matches.
//
// Deliberately dumb: it only ever POSTs a chosen bucket to
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
import type { LandingPresentationCountry } from '@/lib/services/landingCountryContext';

export interface CountrySelectorOption {
  code: LandingPresentationCountry;
  label: string;
}

/** The exactly-three PO-approved landing presentation choices. Not a country registry — 'GLOBAL' is an experience category, never an ISO country (see lib/services/landingCountryContext.ts's module header). */
export const COUNTRY_SELECTOR_OPTIONS: CountrySelectorOption[] = [
  { code: 'AU', label: 'Australia' },
  { code: 'IN', label: 'India' },
  { code: 'GLOBAL', label: 'Global' },
];

const UNRESOLVED_VALUE = '__UNRESOLVED__';

export interface CountrySelectorProps {
  /** The currently active presentation bucket, or null if nothing has resolved yet (neutral prompt, no preselection — PO detection-mapping table row 4). */
  activeCountry: LandingPresentationCountry | null;
}

export function CountrySelector({ activeCountry }: CountrySelectorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  async function applySelection(code: LandingPresentationCountry) {
    setError(null);
    try {
      const response = await fetch('/api/landing/country', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ country: code }),
      });
      if (!response.ok) {
        setError('Could not update your selection. Please try again.');
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not update your selection. Please try again.');
    }
  }

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value === UNRESOLVED_VALUE) return; // placeholder re-selected -- no-op
    void applySelection(value as LandingPresentationCountry);
  }

  const selectValue = activeCountry ?? UNRESOLVED_VALUE;

  return (
    <div className={styles.wrap}>
      <span id={labelId} className={styles.label}>
        Experience
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
          {!activeCountry && <option value={UNRESOLVED_VALUE}>Choose your experience&hellip;</option>}
          {COUNTRY_SELECTOR_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className={styles.chev} aria-hidden="true">
          &#9662;
        </span>
      </div>
      <p id={`${labelId}-hint`} className={styles.hint}>
        Choose Australia, India or Global to tailor examples and pricing information. This changes the website
        experience only &mdash; it does not confirm your account or billing residence, which you can confirm
        separately.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--red, #dc2626)', fontSize: '0.7rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}
