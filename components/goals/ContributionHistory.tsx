'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';
import type { GoalContributionRow } from '@/lib/services/goalsData';

const TYPE_OPTIONS = [
  { value: 'regular', label: 'Regular saving' },
  { value: 'one_off', label: 'One-off' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'tax_refund', label: 'Tax refund' },
  { value: 'family', label: 'Family contribution' },
  { value: 'asset_sale', label: 'Asset sale proceeds' },
  { value: 'withdrawal', label: 'Withdrawal' },
  { value: 'adjustment', label: 'Adjustment' },
];

const emptyForm = { contribution_date: '', amount: '', contribution_type: 'regular' };

export function ContributionHistory({
  goalId,
  initial,
  currency,
}: {
  goalId: string;
  initial: GoalContributionRow[];
  currency: 'AUD' | 'INR';
}) {
  const [contributions, setContributions] = useState(initial);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addContribution(e: React.FormEvent) {
    e.preventDefault();
    if (!form.contribution_date || !form.amount) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/contributions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contribution_date: form.contribution_date,
          amount: Number(form.amount),
          currency_code: currency,
          contribution_type: form.contribution_type,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save contribution');
      setContributions((prev) => [json.data, ...prev]);
      setForm(emptyForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  async function reverseContribution(id: string) {
    await fetch(`/api/goals/${goalId}/contributions/${id}`, { method: 'DELETE' });
    setContributions((prev) => prev.map((c) => (c.id === id ? { ...c, contribution_status: 'reversed' } : c)));
  }

  return (
    <SectionCard title="Contribution History" description="Actual contributions and withdrawals recorded against this goal.">
      <div className="space-y-2">
        {contributions.length === 0 ? (
          <p className="text-sm text-gray-500">No contributions recorded yet.</p>
        ) : (
          contributions.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-gray-800">
                  {formatDateShort(c.contribution_date, currency)} · {c.contribution_type.replace(/_/g, ' ')}
                </p>
                {c.contribution_status === 'reversed' && <p className="text-xs text-gray-400">Reversed</p>}
              </div>
              <div className="flex items-center gap-3">
                <span className={`font-medium ${c.contribution_status === 'reversed' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                  {formatMoney(c.amount, currency)}
                </span>
                {c.contribution_status === 'confirmed' && (
                  <button onClick={() => reverseContribution(c.id)} className="text-xs text-risk hover:underline">
                    Reverse
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={addContribution} className="mt-4 grid grid-cols-1 gap-2 border-t pt-4 sm:grid-cols-4">
        <input
          type="date"
          value={form.contribution_date}
          onChange={(e) => setForm({ ...form, contribution_date: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <input
          type="number"
          step="0.01"
          placeholder="Amount"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <select
          value={form.contribution_type}
          onChange={(e) => setForm({ ...form, contribution_type: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={saving} className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving...' : 'Add contribution'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </SectionCard>
  );
}
