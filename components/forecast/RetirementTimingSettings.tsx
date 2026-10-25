'use client';

import { DateInput } from '@/components/ui/DateInput';
import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { describeMemberTiming, type RetirementTiming } from '@/lib/engines/forecast/retirementTiming';

// Forecasting P1 fix FHIP-FC-RET-001 — collects the retirement-timing
// hierarchy's remaining inputs: retirement_date (tier 1 — takes priority
// over the age-based calculation when a date of birth is on file) and
// retirement_timing_override_months (a manual fallback used only when
// there's no date of birth to derive current age from at all).
//
// Retirement Member UI (spec s.28): the target-retirement-age field that
// used to live here (forecast_profiles.retirement_age) has been removed.
// retirement_members is now the canonical, single source of truth for
// target retirement age — set once per member (Self/Spouse) on the
// Retirement page, not duplicated here. lib/services/forecastData.ts reads
// retirement_members first, falling back to any pre-existing
// forecast_profiles.retirement_age value already on file for continuity.
//
// Document2 (4) F26 (20-10-2026): this card now STATES the target age(s) already saved on the Retirement page (and where each came
// from) instead of presenting only blank inputs, which read as a second request for the same fact. The exact date and the
// months fallback stay, labelled as optional overrides saved with the forecast settings. The months fallback is shown only when
// there is no usable date of birth, the only case in which it is used.
export function RetirementTimingSettings({
  initialRetirementDate,
  initialOverrideMonths,
  timing,
}: {
  initialRetirementDate: string | null;
  initialOverrideMonths: number | null;
  timing: RetirementTiming;
}) {
  const [retirementDate, setRetirementDate] = useState(initialRetirementDate ?? '');
  const [overrideMonths, setOverrideMonths] = useState(initialOverrideMonths?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/forecast/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          retirement_date: retirementDate === '' ? null : retirementDate,
          // Only sent when the field is shown; a date of birth on file means this fallback is not used and must not be silently altered.
          ...(timing.self.hasPlausibleDateOfBirth ? {} : { retirement_timing_override_months: overrideMonths === '' ? null : Number(overrideMonths) }),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save retirement timing');
      setMessage('Saved. Re-run the forecast to see the updated projection.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Retirement timing"
      description="Your target retirement age is read from the Retirement page, where you set it once for each person. You do not need to enter it again here."
    >
      <ul className="mb-4 space-y-1 text-sm text-ink" aria-label="Target retirement age in use">
        <li data-testid="timing-self">{describeMemberTiming(timing.self)}</li>
        {timing.spouse && <li data-testid="timing-spouse">{describeMemberTiming(timing.spouse)}</li>}
      </ul>
      {timing.timingSource === 'exact_date' && (
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="timing-exact-date-note">
          An exact retirement date is saved below, so this forecast uses that date instead of the target age. Clear the date and save to go back to the target age.
        </p>
      )}
      <p className="mb-3 text-sm">
        <Link href="/retirement" className="text-trust underline">Change the target retirement age on the Retirement page</Link>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="retirement_date" className="block text-sm text-gray-600">
            Exact retirement date (optional override, saved with your forecast settings)
          </label>
          <DateInput
            id="retirement_date"
            value={retirementDate}
            onChange={(e) => setRetirementDate(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        {!timing.self.hasPlausibleDateOfBirth && (
          <div>
            <label htmlFor="override_months" className="block text-sm text-gray-600">
              Months until retirement (used only because no date of birth is on file; add it in your Profile to use your age instead)
            </label>
            <input
              id="override_months"
              type="number"
              min={0}
              value={overrideMonths}
              onChange={(e) => setOverrideMonths(e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
              placeholder="e.g. 180"
            />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving...' : 'Save'}
        </button>
        {message && <p className="text-sm text-progress">{message}</p>}
        {error && <p className="text-sm text-risk">{error}</p>}
      </div>
    </SectionCard>
  );
}
