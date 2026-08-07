'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';

// Forecasting P1 fix FHIP-FC-RET-001 — collects the retirement-timing
// hierarchy's inputs: retirement_age (tier 2, already existed on
// forecast_profiles but had no write path anywhere), retirement_date (tier
// 1 — takes priority over the age-based calculation when a date of birth is
// on file), and retirement_timing_override_months (a manual fallback used
// only when there's no date of birth to derive current age from at all).
// All three fields are always shown rather than conditionally hiding based
// on whether a DOB is on file — simpler, and harmless to fill in a field
// that happens not to be the active tier right now.
export function RetirementTimingSettings({
  initialRetirementAge,
  initialRetirementDate,
  initialOverrideMonths,
}: {
  initialRetirementAge: number | null;
  initialRetirementDate: string | null;
  initialOverrideMonths: number | null;
}) {
  const [retirementAge, setRetirementAge] = useState(initialRetirementAge?.toString() ?? '');
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
          retirement_age: retirementAge === '' ? null : Number(retirementAge),
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
      description="Used to project when retirement is reached. If a date of birth is on file, retirement date (or retirement age) is used; otherwise the manual fallback below is used."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="retirement_age" className="block text-sm text-gray-600">
            Retirement age
          </label>
          <input
            id="retirement_age"
            type="number"
            min={1}
            max={119}
            value={retirementAge}
            onChange={(e) => setRetirementAge(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
            placeholder="e.g. 65"
          />
        </div>
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
