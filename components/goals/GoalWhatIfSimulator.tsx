'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { CategoryForecastResult, ScenarioCode } from '@/lib/engines/goalForecast';

export function GoalWhatIfSimulator({
  goalId,
  currentContribution,
  currency,
}: {
  goalId: string;
  currentContribution: number;
  currency: 'AUD' | 'INR';
}) {
  const [contribution, setContribution] = useState(currentContribution);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    before: Record<ScenarioCode, CategoryForecastResult>;
    after: Record<ScenarioCode, CategoryForecastResult>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/forecast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_contribution: contribution }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not run scenario');
      setResult(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard
      title="What-If Goal Simulator"
      description="Test how changing your monthly contribution would affect this goal. Nothing is saved unless you update the actual plan."
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500">Monthly contribution</label>
          <input
            type="number"
            value={contribution}
            onChange={(e) => setContribution(Number(e.target.value))}
            className="mt-1 w-40 rounded border px-3 py-2 text-sm"
          />
        </div>
        <button onClick={run} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
          {loading ? 'Calculating...' : 'Run scenario'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}
      {result && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="py-1">Measure</th>
              <th className="py-1">Current Plan</th>
              <th className="py-1">Scenario</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="py-1">Completion date</td>
              <td className="py-1">
                {result.before.base.projectedCompletionDate
                  ? new Date(result.before.base.projectedCompletionDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
                  : '—'}
              </td>
              <td className="py-1 font-semibold text-trust">
                {result.after.base.projectedCompletionDate
                  ? new Date(result.after.base.projectedCompletionDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
                  : '—'}
              </td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Required contribution</td>
              <td className="py-1">
                {result.before.base.requiredMonthlyContribution !== null
                  ? formatMoney(result.before.base.requiredMonthlyContribution, currency)
                  : '—'}
              </td>
              <td className="py-1 font-semibold text-trust">
                {result.after.base.requiredMonthlyContribution !== null
                  ? formatMoney(result.after.base.requiredMonthlyContribution, currency)
                  : '—'}
              </td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Target-date funding</td>
              <td className="py-1">{result.before.base.forecastFundingPct !== null ? `${result.before.base.forecastFundingPct.toFixed(0)}%` : '—'}</td>
              <td className="py-1 font-semibold text-trust">
                {result.after.base.forecastFundingPct !== null ? `${result.after.base.forecastFundingPct.toFixed(0)}%` : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
