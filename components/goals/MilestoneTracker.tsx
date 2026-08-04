'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalMilestoneRow } from '@/lib/services/goalsData';

const emptyForm = { milestone_name: '', target_amount: '', target_date: '' };

export function MilestoneTracker({ goalId, initial, currency }: { goalId: string; initial: GoalMilestoneRow[]; currency: 'AUD' | 'INR' }) {
  const [milestones, setMilestones] = useState(initial);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  async function addMilestone(e: React.FormEvent) {
    e.preventDefault();
    if (!form.milestone_name || !form.target_amount) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/goals/${goalId}/milestones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          milestone_name: form.milestone_name,
          target_amount: Number(form.target_amount),
          target_date: form.target_date || undefined,
          display_order: milestones.length,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setMilestones((prev) => [...prev, json.data]);
        setForm(emptyForm);
      }
    } finally {
      setSaving(false);
    }
  }

  async function markAchieved(id: string) {
    const res = await fetch(`/api/goals/${goalId}/milestones/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'achieved' }),
    });
    if (res.ok) {
      const json = await res.json();
      setMilestones((prev) => prev.map((m) => (m.id === id ? json.data : m)));
    }
  }

  return (
    <SectionCard title="Milestones" description="Break this goal into smaller checkpoints you can celebrate along the way.">
      <div className="space-y-2">
        {milestones.length === 0 ? (
          <p className="text-sm text-gray-500">No milestones added yet.</p>
        ) : (
          milestones
            .slice()
            .sort((a, b) => a.display_order - b.display_order)
            .map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                <div>
                  <p className={`font-medium ${m.status === 'achieved' ? 'text-progress' : 'text-gray-800'}`}>{m.milestone_name}</p>
                  <p className="text-xs text-gray-500">
                    {formatMoney(m.target_amount, currency)}
                    {m.target_date && ` · ${new Date(m.target_date).toLocaleDateString('en-AU')}`}
                  </p>
                </div>
                {m.status === 'achieved' ? (
                  <span className="text-xs font-medium text-progress">✓ Achieved</span>
                ) : (
                  <button onClick={() => markAchieved(m.id)} className="text-xs font-medium text-trust hover:underline">
                    Mark achieved
                  </button>
                )}
              </div>
            ))
        )}
      </div>

      <form onSubmit={addMilestone} className="mt-4 grid grid-cols-1 gap-2 border-t pt-4 sm:grid-cols-4">
        <input
          type="text"
          placeholder="Milestone name"
          value={form.milestone_name}
          onChange={(e) => setForm({ ...form, milestone_name: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm sm:col-span-2"
        />
        <input
          type="number"
          placeholder="Target amount"
          value={form.target_amount}
          onChange={(e) => setForm({ ...form, target_amount: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <input
          type="date"
          value={form.target_date}
          onChange={(e) => setForm({ ...form, target_date: e.target.value })}
          className="rounded border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={saving} className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60 sm:col-span-4">
          {saving ? 'Saving...' : 'Add milestone'}
        </button>
      </form>
    </SectionCard>
  );
}
