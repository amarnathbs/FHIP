'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { PENDING_GOAL_STORAGE_KEY } from '@/lib/constants';
import { resolveConfirmCountryPreselect, type CountryGateState } from '@/lib/services/countryGate';
import type { CountryCoverageDisclosure } from '@/lib/services/countryDisclosure';
import type { CountryCode } from '@/lib/services/jurisdiction';

// Mandatory Country Confirmation, round-3 closure (Gap 1) — creates the
// onboarding wizard's optional "first goal" here, immediately AFTER
// confirmation succeeds, instead of during onboarding itself. By this
// point the caller is genuinely CONFIRMED (this request just made them so),
// so POST /api/goals goes through the exact same guard every other goal
// creation does — no DB-trigger or API-layer onboarding exemption is
// involved at all. A failure here never blocks the redirect to /dashboard;
// losing an optional draft goal is a much smaller problem than trapping a
// user who has successfully confirmed their country.
//
// G3: only attempted for a FULL-experience country. A generic-country user
// cannot hold goals at all (the database refuses them — migration 0127's
// header), so attempting the write would produce a guaranteed, confusing
// failure rather than a best-effort success.
async function createPendingGoalIfAny(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_GOAL_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const pending = JSON.parse(raw);
    await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending),
    });
  } catch {
    // Best-effort only — see function comment.
  } finally {
    try {
      sessionStorage.removeItem(PENDING_GOAL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

export interface ConfirmCountryOption {
  value: CountryCode;
  label: string;
  experienceLevel: 'FULL' | 'GENERIC' | 'UNAVAILABLE';
  disclosure: CountryCoverageDisclosure;
}

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
  COUNTRY_REGISTRATION_NOT_PERMITTED: {
    heading: 'FHIP is not yet available for your recorded country',
    body:
      'FHIP’s authenticated experience is not yet available for the country currently on your account. Please choose your actual country of residence below if it is one of the options, or sign out.',
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
  COUNTRY_REGISTRATION_NOT_PERMITTED:
    'FHIP is not currently accepting registrations for that country. Please choose another country you genuinely live in, or sign out.',
  GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED:
    'Please read and tick the coverage acknowledgement before confirming.',
  PROFILE_INCOMPLETE: "We couldn't find your profile. Please try signing out and back in.",
  OPERATIONAL_ERROR: 'Something went wrong saving your country. Please try again.',
};

export function ConfirmCountryForm({
  initialState,
  currentCountry,
  options,
  landingBucket,
  registryUnavailable,
}: {
  initialState: CountryGateState;
  currentCountry: string | null;
  options: ConfirmCountryOption[];
  landingBucket: 'AU' | 'IN' | 'GLOBAL' | null;
  registryUnavailable: boolean;
}) {
  const router = useRouter();

  // Pre-selection precedence, highest authority first (spec 5.2 / G3 6.2):
  //
  //   1. A value already ON THE ACCOUNT that is genuinely offered. This is
  //      the user's own previously-recorded country and outranks anything a
  //      cookie says — which is exactly what makes scenario G3-14 (a forged
  //      AU landing cookie against a user selecting IN) safe.
  //   2. The G2 landing bucket, but ONLY when it is a real country (AU/IN).
  //      'GLOBAL' is not a country and deliberately preselects NOTHING —
  //      a Global visitor must actively state where they live.
  //   3. Nothing. The user chooses from scratch.
  //
  // In every case the value is only a starting position for a control the
  // user must still operate and submit. Nothing here confirms anything.
  const preselect = useMemo(
    () =>
      resolveConfirmCountryPreselect({
        currentCountry,
        landingBucket,
        offeredCountries: options.map((o) => o.value),
      }),
    [options, currentCountry, landingBucket]
  );

  const [country, setCountry] = useState<string>(preselect);
  const [acknowledged, setAcknowledged] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const copy = STATE_COPY[initialState];
  const showError = touched && country === '';
  const selected = options.find((o) => o.value === country) ?? null;
  const disclosure = selected?.disclosure ?? null;
  const needsAcknowledgement = disclosure?.requiresAcknowledgement === true;
  const showAckError = touched && needsAcknowledgement && !acknowledged;

  // Changing country invalidates any acknowledgement already given — an
  // acknowledgement is for a specific country's coverage, and silently
  // carrying it across would let a user confirm GB having only ever read the
  // US wording. (The server and the database both re-check this
  // independently; this is the UI half of the same rule.)
  function handleCountryChange(next: string) {
    setCountry(next);
    setAcknowledged(false);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!country || submitting || done) return; // prevent blank submission + double submit
    if (needsAcknowledgement && !acknowledged) return;
    setSubmitting(true);
    try {
      const result = await fetchJson<{ experience_level?: string }>('/api/user/country/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country_of_residence: country,
          // Sent only when the SERVER-derived disclosure for this country
          // actually requires it. The version travels from the server's own
          // disclosure payload — the client never invents a version string,
          // and the server accepts only its current one.
          ...(needsAcknowledgement && disclosure?.version
            ? { acknowledged_disclosure_version: disclosure.version }
            : {}),
        }),
      });
      // The destination is decided by the SERVER's returned experience level,
      // not by what the client thought it selected.
      const generic = result?.experience_level === 'GENERIC';
      if (!generic) await createPendingGoalIfAny();
      setDone(true);
      router.push(generic ? '/global-setup' : '/dashboard');
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
          Your display currency does not determine your country, and confirming your country never changes, hides or
          deletes any financial data you&apos;ve already entered.
        </p>
      </div>

      {landingBucket === 'GLOBAL' && (
        <div className="rounded border border-line bg-app p-4 text-sm text-muted">
          You were browsing the Global version of our site. Global is not a country — please select the country you
          actually live in below.
        </div>
      )}

      {copy && (
        <div role="alert" className="rounded border border-risk/40 bg-risk/5 p-4 text-sm text-ink">
          <p className="font-medium">{copy.heading}</p>
          <p className="mt-1 text-muted">{copy.body}</p>
        </div>
      )}

      {/* Truthful failure state (spec section 16). An empty list because the
          registry could not be read is NOT the same as "no countries are
          offered", and must never be presented as if it were. */}
      {registryUnavailable && (
        <div role="alert" className="rounded border border-risk/40 bg-risk/5 p-4 text-sm text-ink">
          <p className="font-medium">We couldn&apos;t load the list of available countries</p>
          <p className="mt-1 text-muted">
            This is a temporary problem on our side, not a decision about your country. Please refresh the page and
            try again.
          </p>
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
              onChange={(e) => handleCountryChange(e.target.value)}
              onBlur={() => setTouched(true)}
              required
              aria-required="true"
              aria-invalid={showError}
              aria-describedby={showError ? 'confirm-country-error' : undefined}
              disabled={submitting || done || options.length === 0}
              className={`mt-1 w-full rounded border px-3 py-2 text-sm ${showError ? 'border-risk' : 'border-line'}`}
            >
              <option value="" disabled>
                Select a country…
              </option>
              {options.map((o) => (
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
            <p className="mt-2 text-xs text-muted">
              Don&apos;t see your country? FHIP&apos;s authenticated experience is not yet available for it. You may
              review the public Global information, but please do not select another country unless it is genuinely
              your residence.
            </p>
          </div>

          {/* The coverage explanation. Rendered from the SERVER-derived
              experience level for the selected country — the client has no
              way to decide that a country is FULL. */}
          {disclosure && (
            <div
              className="rounded border border-line bg-app p-4"
              role="region"
              aria-live="polite"
              aria-label="Coverage for the selected country"
            >
              <p className="text-sm font-medium text-ink">{disclosure.headline}</p>
              <p className="mt-1 text-sm text-muted">{disclosure.body}</p>
              {disclosure.points.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
                  {disclosure.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Never pre-checked (spec section 16). An acknowledgement the user
              did not actively give is not an acknowledgement. */}
          {needsAcknowledgement && disclosure?.acknowledgementLabel && (
            <div>
              <label htmlFor="generic-disclosure-ack" className="flex items-start gap-2 text-sm text-ink">
                <input
                  id="generic-disclosure-ack"
                  name="generic_disclosure_acknowledged"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  onBlur={() => setTouched(true)}
                  disabled={submitting || done}
                  aria-required="true"
                  aria-invalid={showAckError}
                  aria-describedby={showAckError ? 'generic-disclosure-ack-error' : undefined}
                  className="mt-1"
                />
                <span>{disclosure.acknowledgementLabel}</span>
              </label>
              {showAckError && (
                <p id="generic-disclosure-ack-error" role="alert" className="mt-1 text-xs text-risk">
                  Please confirm you understand what is and isn&apos;t available for your country.
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-risk">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || done || options.length === 0}
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
