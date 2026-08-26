'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatMoney } from '@/lib/engines/money';

interface GoalLink {
  id: string;
  goal_id: string;
  allocated_amount: number;
  allocation_percentage: number | null;
  goal_name: string;
  goal_target_amount: number;
  goal_currency_code: string;
}

interface EligibleGoal {
  id: string;
  goalName: string;
  targetAmount: number;
  currencyCode: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

// Investment -> Goal linkage (spec s.24/26-28/57): "Goals" control on the
// Investments grid, the mirror image of GoalDetail's own FundingSourceList
// — both read and write the same goal_funding_sources rows (spec s.27:
// one canonical relationship, never two independent links). Modelled on
// PropertyFinancingControl's proven compact-inline-control UX.
export function GoalLinkControl({ investmentId }: { investmentId: string }) {
  const [links, setLinks] = useState<GoalLink[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [eligibleGoals, setEligibleGoals] = useState<EligibleGoal[] | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [allocationPct, setAllocationPct] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<GoalLink[]>(`/api/investments/${investmentId}/goal-links`)
      .then((data) => !cancelled && setLinks(data))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
  }, [investmentId]);

  async function openPicker() {
    setPicking(true);
    setError(null);
    if (!eligibleGoals) {
      const data = await fetchJson<EligibleGoal[]>('/api/goals/summary').catch(() => []);
      setEligibleGoals(data);
    }
  }

  async function submitLink() {
    if (!selectedGoalId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await fetchJson<{ id: string; goal_id: string; allocated_amount: number; allocation_percentage: number | null }>(
        `/api/investments/${investmentId}/goal-links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal_id: selectedGoalId, allocation_percentage: Number(allocationPct) }),
        }
      );
      const goal = eligibleGoals?.find((g) => g.id === selectedGoalId);
      setLinks((prev) => [
        ...(prev ?? []),
        {
          ...created,
          goal_name: goal?.goalName ?? 'Goal',
          goal_target_amount: goal?.targetAmount ?? 0,
          goal_currency_code: goal?.currencyCode ?? 'AUD',
        },
      ]);
      setPicking(false);
      setSelectedGoalId('');
      setAllocationPct('100');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link this goal.');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkId: string) {
    setBusy(true);
    try {
      await fetchJson(`/api/investments/${investmentId}/goal-links/${linkId}`, { method: 'DELETE' });
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== linkId));
    } catch {
      // best effort
    } finally {
      setBusy(false);
    }
  }

  if (links === null) return null;

  return (
    <div className="text-xs">
      {links.length === 0 && !picking && (
        <div className="flex items-center gap-2">
          <span className="text-muted">No goal linked</span>
          <button onClick={openPicker} className="text-trust hover:underline">
            + Link goal
          </button>
        </div>
      )}

      {links.map((l) => (
        <div key={l.id} className="mb-1 flex items-center gap-2 rounded bg-blue-50 px-2 py-1 text-blue-800">
          <span>
            {l.goal_name}
            {l.allocation_percentage !== null ? ` — ${l.allocation_percentage}%` : ` — ${formatMoney(l.allocated_amount, l.goal_currency_code as 'AUD' | 'INR')}`}
          </span>
          <button disabled={busy} onClick={() => unlink(l.id)} className="text-[11px] text-risk hover:underline disabled:opacity-50">
            Unlink
          </button>
        </div>
      ))}

      {links.length > 0 && !picking && (
        <button onClick={openPicker} className="text-trust hover:underline">
          + Link another goal
        </button>
      )}

      {picking && (
        <div className="mt-1 space-y-1 rounded border border-line bg-gray-50 p-2">
          <select value={selectedGoalId} onChange={(e) => setSelectedGoalId(e.target.value)} className="w-full rounded border px-1 py-0.5">
            <option value="">Select a goal...</option>
            {(eligibleGoals ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.goalName} — {formatMoney(g.targetAmount, g.currencyCode as 'AUD' | 'INR')} target
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="0"
              max="100"
              value={allocationPct}
              onChange={(e) => setAllocationPct(e.target.value)}
              className="w-16 rounded border px-1 py-0.5"
            />
            <span className="text-muted">% of this investment&apos;s value</span>
          </div>
          {error && <p className="text-risk">{error}</p>}
          <div className="flex gap-2">
            <button disabled={!selectedGoalId || busy} onClick={submitLink} className="rounded bg-primary px-2 py-0.5 text-white disabled:opacity-50">
              Link
            </button>
            <button
              onClick={() => {
                setPicking(false);
                setError(null);
              }}
              className="text-muted hover:underline"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-muted">
            Don&apos;t see the right goal?{' '}
            <Link href="/goals" className="text-trust hover:underline">
              Create one on the Goals page
            </Link>{' '}
            first, then link it here.
          </p>
        </div>
      )}
    </div>
  );
}
