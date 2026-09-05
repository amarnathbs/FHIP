'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatDateShort } from '@/lib/engines/date';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';

interface CheckIns {
  goals_reviewed_at: string | null;
  insurance_reviewed_at: string | null;
  debt_reviewed_at: string | null;
  investment_plan_reviewed_at: string | null;
  beneficiaries_reviewed_at: string | null;
  bills_paid_on_time: boolean | null;
  budget_maintained: boolean | null;
  savings_automated: boolean | null;
}

const REVIEW_FIELDS: { key: keyof CheckIns; label: string }[] = [
  { key: 'goals_reviewed_at', label: 'Goals reviewed' },
  { key: 'insurance_reviewed_at', label: 'Insurance reviewed' },
  { key: 'debt_reviewed_at', label: 'Debt reviewed' },
  { key: 'investment_plan_reviewed_at', label: 'Investment plan reviewed' },
  { key: 'beneficiaries_reviewed_at', label: 'Beneficiaries updated' },
];

const TOGGLE_FIELDS: { key: keyof CheckIns; label: string }[] = [
  { key: 'bills_paid_on_time', label: 'Bills paid on time' },
  { key: 'budget_maintained', label: 'Budget maintained' },
  { key: 'savings_automated', label: 'Savings automated' },
];

function isRecent(d: string | null): boolean {
  if (!d) return false;
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return new Date(d) >= oneYearAgo;
}

export function CheckInsPanel({ initial, currency }: { initial: Partial<CheckIns> | null; currency: 'AUD' | 'INR' }) {
  const [state, setState] = useState<Partial<CheckIns>>(initial ?? {});
  const [saving, setSaving] = useState(false);
  // G4 closure item 2 (Product Owner, 2026-09-05): check-ins PUT-upserts to
  // health_check_ins, a genuine write — Scores is VIEW-ENABLED for GENERIC
  // but this write path isn't yet G5-certified, so the controls below must
  // be disabled rather than offered live.
  const { available: writeAvailable, resolved: writeResolved } = useModuleWriteAvailability('SCORES');
  const writeUnavailable = writeResolved && !writeAvailable;

  async function save(patch: Partial<CheckIns>) {
    const next = { ...state, ...patch };
    setState(next);
    setSaving(true);
    try {
      await fetch('/api/health-score/check-ins', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Financial Management Behaviour Check-In"
      description="These self-declared habits feed the Financial Management Behaviour component of your score."
    >
      {writeUnavailable && (
        <LockedFeatureCard
          title="Check-ins aren't available for your country yet"
          description="Recording these habits hasn't been independently certified safe for your country yet — that's the next capability phase, not an error."
        />
      )}
      <fieldset disabled={writeUnavailable} className="contents border-0 p-0 m-0">
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REVIEW_FIELDS.map((f) => {
          const value = state[f.key] as string | null | undefined;
          const recent = isRecent(value ?? null);
          return (
            <div key={f.key} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <div>
                <p className="text-gray-700">{f.label}</p>
                <p className={`text-xs ${recent ? 'text-progress' : 'text-gray-400'}`}>
                  {value ? formatDateShort(value, currency) : 'Not recorded'}
                </p>
              </div>
              <button
                onClick={() => save({ [f.key]: new Date().toISOString().slice(0, 10) })}
                disabled={saving}
                className="rounded bg-trust px-2 py-1 text-xs text-white disabled:opacity-60"
              >
                Mark reviewed
              </button>
            </div>
          );
        })}
        {TOGGLE_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
            <span className="text-gray-700">{f.label}</span>
            <input
              type="checkbox"
              checked={Boolean(state[f.key])}
              onChange={(e) => save({ [f.key]: e.target.checked })}
            />
          </label>
        ))}
      </div>
      </fieldset>
    </SectionCard>
  );
}
