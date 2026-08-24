'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';

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
export function RetirementTimingSettings({
  initialRetirementDate,
  initialOverrideMonths,
}: {
  initialRetirementDate: string | null;
  initialOverrideMonths: number | null;
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
          retirement_timing_override_months: overrideMonths === '' ? null : Number(overrideMonths),
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
      description="Target retirement age is set on the Retirement page, once per person (Self/Spouse). This section only covers an optional exact retirement date, or a manual fallback if no date of birth is on file."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="retirement_date" className="block text-sm text-gray-600">
            Retirement date (optional, most precise)
          </label>
          <input
            id="retirement_date"
            type="date"
            value={retirementDate}
            onChange={(e) => setRetirementDate(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="override_months" className="block text-sm text-gray-600">
            Months until retirement (fallback — no date of birth on file)
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
