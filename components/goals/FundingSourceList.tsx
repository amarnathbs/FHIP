'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalFundingSourceRow } from '@/lib/services/goalsData';

const SOURCE_TYPE_OPTIONS = [
  { value: 'manual', label: 'Manual / unlinked funds' },
  { value: 'cash', label: 'Cash account' },
  { value: 'expected', label: 'Expected (bonus, sale, family)' },
];

const emptyForm = { source_type: 'manual', allocated_amount: '' };

export function FundingSourceList({
  goalId,
  initial,
  currency,
}: {
  goalId: string;
  initial: GoalFundingSourceRow[];
  currency: 'AUD' | 'INR';
}) {
  const [sources, setSources] = useState(initial);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    if (!form.allocated_amount) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/funding-sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: form.source_type,
          allocated_amount: Number(form.allocated_amount),
          currency_code: currency,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save funding source');
      setSources((prev) => [...prev, json.data]);
      setForm(emptyForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  async function removeSource(id: string) {
    setSources((prev) => prev.filter((s) => s.id !== id));
    await fetch(`/api/goals/${goalId}/funding-sources/${id}`, { method: 'DELETE' });
  }

  return (
    <SectionCard
      title="Funding Sources"
      description="Where this goal's current balance comes from. Sources linked to a specific asset or investment can be split by allocation percentage — the same balance can't be fully counted toward two goals at once."
    >
      <div className="space-y-2">
        {sources.length === 0 ? (
          <p className="text-sm text-gray-500">No funding sources linked — this goal&apos;s current amount is tracked manually.</p>
        ) : (
          sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-gray-800">{s.source_type.replace(/_/g, ' ')}</p>
                {s.allocation_percentage !== null && <p className="text-xs text-gray-500">{s.allocation_percentage}% allocated</p>}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-medium text-gray-900">{formatMoney(s.allocated_amount, currency)}</span>
                <button onClick={() => removeSource(s.id)} className="text-xs text-risk hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <form onSubmit={addSource} className="mt-4 grid grid-cols-1 gap-2 border-t pt-4 sm:grid-cols-3">
        <select
          value={form.source_type}
          onChange={(e) => setForm({ ...form, source_type: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        >
          {SOURCE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="0.01"
          placeholder="Allocated amount"
          value={form.allocated_amount}
          onChange={(e) => setForm({ ...form, allocated_amount: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={saving} className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving...' : 'Add source'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </SectionCard>
  );
}
