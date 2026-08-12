'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';

export interface Commitment {
  id: string;
  commitment_name: string;
  category: string;
  amount: number;
  due_date: string;
  is_mandatory: boolean;
  notes: string | null;
}

const CATEGORY_OPTIONS = [
  { value: 'tax', label: 'Tax' },
  { value: 'education', label: 'Education' },
  { value: 'property', label: 'Property' },
  { value: 'legal', label: 'Legal' },
  { value: 'medical', label: 'Medical' },
  { value: 'other', label: 'Other' },
];

const emptyForm = { commitment_name: '', category: 'other', amount: '', due_date: '', is_mandatory: true };

export function CommitmentsManager({ initial, currency }: { initial: Commitment[]; currency: 'AUD' | 'INR' }) {
  const [commitments, setCommitments] = useState<Commitment[]>(initial);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addCommitment(e: React.FormEvent) {
    e.preventDefault();
    if (!form.commitment_name || !form.amount || !form.due_date) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitment_name: form.commitment_name,
          category: form.category,
          amount: Number(form.amount),
          due_date: form.due_date,
          is_mandatory: form.is_mandatory,
          currency_code: currency,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save commitment');
      setCommitments((prev) => [...prev, json.data]);
      setForm(emptyForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  async function removeCommitment(id: string) {
    setCommitments((prev) => prev.filter((c) => c.id !== id));
    await fetch(`/api/commitments/${id}`, { method: 'DELETE' });
  }

  return (
    <SectionCard
      title="Future Financial Commitments"
      description="Known upcoming outflows (tax due, school fees, property settlement) — excluded from your accessible emergency reserves so the Emergency Fund score isn't overstated."
    >
      <div className="space-y-2">
        {commitments.length === 0 ? (
          <p className="text-sm text-gray-500">No upcoming commitments recorded.</p>
        ) : (
          commitments
            .slice()
            .sort((a, b) => a.due_date.localeCompare(b.due_date))
            .map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-gray-800">{c.commitment_name}</p>
                  <p className="text-xs text-gray-500">
                    {formatDateShort(c.due_date, currency)} · {c.category} · {c.is_mandatory ? 'Mandatory' : 'Optional'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{formatMoney(c.amount, currency)}</span>
                  <button onClick={() => removeCommitment(c.id)} className="text-xs text-risk hover:underline">
                    Remove
                  </button>
                </div>
              </div>
            ))
        )}
      </div>

      <form onSubmit={addCommitment} className="mt-4 grid grid-cols-1 gap-2 border-t pt-4 sm:grid-cols-5">
        <input
          type="text"
          placeholder="Name"
          value={form.commitment_name}
          onChange={(e) => setForm({ ...form, commitment_name: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm sm:col-span-2"
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="0.01"
          placeholder="Amount"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <input
          type="date"
          value={form.due_date}
          onChange={(e) => setForm({ ...form, due_date: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <label className="flex items-center gap-2 text-xs text-gray-600 sm:col-span-2">
          <input
            type="checkbox"
            checked={form.is_mandatory}
            onChange={(e) => setForm({ ...form, is_mandatory: e.target.checked })}
          />
          Mandatory (excluded from accessible cash)
        </label>
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60 sm:col-span-3"
        >
          {saving ? 'Saving...' : 'Add commitment'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </SectionCard>
  );
}
