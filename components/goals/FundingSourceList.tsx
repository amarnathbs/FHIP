'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalFundingSourceRow } from '@/lib/services/goalsData';

const SOURCE_TYPE_OPTIONS = [
  { value: 'manual', label: 'Manual / unlinked funds' },
  { value: 'cash', label: 'Cash account' },
  { value: 'expected', label: 'Expected (bonus, sale, family)' },
  // Education/Children Investment -> Goal Linkage (spec s.24/26/58): link an
  // actual owned Investment record — the canonical Goal<->Investment
  // relationship (goal_funding_sources, migration 0009) already supported
  // this; only the UI to select a real investment was missing. Asset/
  // retirement-account linking uses the same schema columns but isn't
  // exposed here yet — out of scope for this release, which targets the
  // Education Fund / Children Investment investment records specifically.
  { value: 'investment', label: 'An investment I own' },
];

type AllocationMode = 'percentage' | 'fixed';

interface OwnedInvestment {
  id: string;
  investment_name: string;
  current_value: number;
  currency_code: string;
}

const emptyForm = { source_type: 'manual', allocated_amount: '', linked_investment_id: '', allocation_mode: 'percentage' as AllocationMode, allocation_percentage: '' };

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
  const [investments, setInvestments] = useState<OwnedInvestment[] | null>(null);

  // Investments are only fetched once the user actually selects "An
  // investment I own" — avoids an extra request for the common case of a
  // goal funded purely by manual/cash/expected sources.
  useEffect(() => {
    if (form.source_type !== 'investment' || investments !== null) return;
    fetch('/api/investments')
      .then((res) => res.json())
      .then((json) => setInvestments((json.data ?? []) as OwnedInvestment[]))
      .catch(() => setInvestments([]));
  }, [form.source_type, investments]);

  const investmentNameById = new Map((investments ?? []).map((inv) => [inv.id, inv.investment_name]));

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    if (form.source_type === 'investment') {
      if (!form.linked_investment_id) return;
      const pctOrAmount = form.allocation_mode === 'percentage' ? form.allocation_percentage : form.allocated_amount;
      if (!pctOrAmount) return;
    } else if (!form.allocated_amount) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        source_type: form.source_type,
        currency_code: currency,
      };
      if (form.source_type === 'investment') {
        body.linked_investment_id = form.linked_investment_id;
        if (form.allocation_mode === 'percentage') {
          body.allocation_percentage = Number(form.allocation_percentage);
          body.allocated_amount = 0; // resolved server-side from the investment's live current_value
        } else {
          body.allocated_amount = Number(form.allocated_amount);
        }
      } else {
        body.allocated_amount = Number(form.allocated_amount);
      }
      const res = await fetch(`/api/goals/${goalId}/funding-sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      description="Where this goal's current balance comes from. Link an investment you own — the underlying holding keeps its own value in Investments/Net Worth unchanged; only its allocated share counts toward this goal's funding. The same balance can't be fully counted toward two goals at once."
    >
      <div className="space-y-2">
        {sources.length === 0 ? (
          <p className="text-sm text-gray-500">No funding sources linked — this goal&apos;s current amount is tracked manually.</p>
        ) : (
          sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-gray-800">
                  {s.source_type === 'investment' && s.linked_investment_id
                    ? investmentNameById.get(s.linked_investment_id) ?? 'Linked investment'
                    : s.source_type.replace(/_/g, ' ')}
                </p>
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

      <form onSubmit={addSource} className="mt-4 space-y-2 border-t pt-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select
            value={form.source_type}
            onChange={(e) => setForm({ ...emptyForm, source_type: e.target.value })}
            className="rounded border px-2 py-1.5 text-sm"
          >
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {form.source_type === 'investment' ? (
            <>
              <select
                value={form.linked_investment_id}
                onChange={(e) => setForm({ ...form, linked_investment_id: e.target.value })}
                className="rounded border px-2 py-1.5 text-sm sm:col-span-2"
              >
                <option value="">
                  {investments === null ? 'Loading your investments…' : investments.length === 0 ? 'No investments on file yet' : 'Select an investment'}
                </option>
                {(investments ?? []).map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.investment_name} — {formatMoney(inv.current_value, inv.currency_code as 'AUD' | 'INR')}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <input
              type="number"
              step="0.01"
              placeholder="Allocated amount"
              value={form.allocated_amount}
              onChange={(e) => setForm({ ...form, allocated_amount: e.target.value })}
              className="rounded border px-2 py-1.5 text-sm sm:col-span-2"
            />
          )}
        </div>

        {form.source_type === 'investment' && form.linked_investment_id && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input
                type="radio"
                checked={form.allocation_mode === 'percentage'}
                onChange={() => setForm({ ...form, allocation_mode: 'percentage' })}
              />
              % of this investment
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <input type="radio" checked={form.allocation_mode === 'fixed'} onChange={() => setForm({ ...form, allocation_mode: 'fixed' })} />
              Fixed amount
            </label>
            {form.allocation_mode === 'percentage' ? (
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                placeholder="% allocated (e.g. 60)"
                value={form.allocation_percentage}
                onChange={(e) => setForm({ ...form, allocation_percentage: e.target.value })}
                className="w-40 rounded border px-2 py-1.5 text-sm"
              />
            ) : (
              <input
                type="number"
                step="0.01"
                placeholder="Fixed allocated amount"
                value={form.allocated_amount}
                onChange={(e) => setForm({ ...form, allocated_amount: e.target.value })}
                className="w-40 rounded border px-2 py-1.5 text-sm"
              />
            )}
          </div>
        )}

        <button type="submit" disabled={saving} className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60">
          {saving ? 'Saving...' : 'Add source'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </SectionCard>
  );
}
