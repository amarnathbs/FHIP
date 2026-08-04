'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';

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

export function CheckInsPanel({ initial }: { initial: Partial<CheckIns> | null }) {
  const [state, setState] = useState<Partial<CheckIns>>(initial ?? {});
  const [saving, setSaving] = useState(false);

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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REVIEW_FIELDS.map((f) => {
          const value = state[f.key] as string | null | undefined;
          const recent = isRecent(value ?? null);
          return (
            <div key={f.key} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <div>
                <p className="text-gray-700">{f.label}</p>
                <p className={`text-xs ${recent ? 'text-progress' : 'text-gray-400'}`}>
                  {value ? new Date(value).toLocaleDateString('en-AU') : 'Not recorded'}
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
    </SectionCard>
  );
}
