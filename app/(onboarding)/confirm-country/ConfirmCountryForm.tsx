'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { COUNTRY_OPTIONS } from '@/lib/constants';
import type { CountryGateState } from '@/lib/services/countryGate';

const STATE_COPY: Partial<Record<CountryGateState, { heading: string; body: string }>> = {
  COUNTRY_UNSUPPORTED: {
    heading: 'FHIP is not yet available for your recorded country',
    body:
      "The country currently on your account isn't one FHIP supports yet. You can pick a supported country below if you've moved, or sign out if this was recorded in error.",
  },
  COUNTRY_INVALID: {
    heading: "We couldn't read your recorded country",
    body: 'The country value on your account is not valid. Please choose your current country of residence below to fix this.',
  },
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Something went wrong.');
  return json.data as T;
}

const FRIENDLY_ERROR: Record<string, string> = {
  COUNTRY_INVALID: 'Please choose a valid country from the list.',
  COUNTRY_UNSUPPORTED: 'FHIP is not yet available for that country. Please choose a supported country, or sign out.',
  PROFILE_INCOMPLETE: "We couldn't find your profile. Please try signing out and back in.",
  OPERATIONAL_ERROR: 'Something went wrong saving your country. Please try again.',
};

export function ConfirmCountryForm({
  initialState,
  currentCountry,
}: {
  initialState: CountryGateState;
  currentCountry: string | null;
}) {
  const router = useRouter();
  // Pre-select an existing value for convenience (spec 5.2: "Existing value
  // but unconfirmed -> Preselect for convenience, but require explicit
  // confirmation") — but a genuinely unsupported/invalid recorded value is
  // never pre-selected as if it were a real choice.
  const preselect = COUNTRY_OPTIONS.some((o) => o.value === currentCountry) ? currentCountry! : '';
  const [country, setCountry] = useState(preselect);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const copy = STATE_COPY[initialState];
  const showError = touched && country === '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!country || submitting || done) return; // prevent blank submission + double submit
    setSubmitting(true);
    try {
      await fetchJson('/api/user/country/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_of_residence: country }),
      });
      setDone(true);
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError(FRIENDLY_ERROR[message] ?? message);
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Confirm your country of residence</h1>
        <p className="mt-2 text-sm text-muted">
          FHIP uses your country of residence to show the appropriate financial options, terminology and
          calculations. This means the country where you currently live — not your citizenship, preferred currency,
          or the country where an investment is held.
        </p>
        <p className="mt-2 text-sm text-muted">
          You can record eligible overseas assets and investments separately once that&apos;s available. Your display
          currency does not determine your country, and confirming your country never changes, hides or deletes any
          financial data you&apos;ve already entered.
        </p>
      </div>

      {copy && (
        <div role="alert" className="rounded border border-risk/40 bg-risk/5 p-4 text-sm text-ink">
          <p className="font-medium">{copy.heading}</p>
          <p className="mt-1 text-muted">{copy.body}</p>
        </div>
      )}

      <SectionCard title="Country of residence" description="Select the country you currently live in.">
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label htmlFor="confirm-country-select" className="block text-sm font-medium text-ink">
              Country of residence<span className="text-risk"> *</span>
            </label>
            <select
              id="confirm-country-select"
              name="country_of_residence"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              onBlur={() => setTouched(true)}
              required
              aria-required="true"
              aria-invalid={showError}
              aria-describedby={showError ? 'confirm-country-error' : undefined}
              disabled={submitting || done}
              className={`mt-1 w-full rounded border px-3 py-2 text-sm ${showError ? 'border-risk' : 'border-line'}`}
            >
              <option value="" disabled>
                Select a country…
              </option>
              {COUNTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {showError && (
              <p id="confirm-country-error" role="alert" className="mt-1 text-xs text-risk">
                Please select your country of residence.
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-risk">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || done}
            aria-busy={submitting}
            className="w-full rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? 'Confirming…' : done ? 'Confirmed' : 'Confirm and continue'}
          </button>
        </form>
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" onClick={() => void handleSignOut()} className="text-muted underline hover:text-ink">
          Sign out
        </button>
        <div className="flex gap-4">
          <a href="/privacy" className="text-muted underline hover:text-ink">
            Privacy
          </a>
          <a href="/terms" className="text-muted underline hover:text-ink">
            Terms
          </a>
        </div>
      </div>
    </div>
  );
}
