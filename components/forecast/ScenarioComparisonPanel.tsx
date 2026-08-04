'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

interface ScenarioComparison {
  scenarioId: string;
  scenarioName: string;
  scenarioType: string;
  oneYear: number | null;
  fiveYear: number | null;
  tenYear: number | null;
}

export function ScenarioComparisonPanel({ currency }: { currency: 'AUD' | 'INR' }) {
  const [comparisons, setComparisons] = useState<ScenarioComparison[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function compare() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/forecast/net-worth/compare-scenarios', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not compare scenarios');
      setComparisons(json.data.comparisons);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard
      title="Net Worth Scenario Comparison"
      description="Runs a net worth forecast for every scenario you've created and compares the projected 1/5/10-year net worth across them."
    >
      <button onClick={compare} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? 'Comparing...' : comparisons ? 'Recompare scenarios' : 'Compare scenarios'}
      </button>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}
      {comparisons && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="py-1">Scenario</th>
              <th className="py-1">1 year</th>
              <th className="py-1">5 years</th>
              <th className="py-1">10 years</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((c) => (
              <tr key={c.scenarioId} className="border-t">
                <td className="py-2 font-medium text-gray-800">
                  {c.scenarioName} <span className="text-xs capitalize text-gray-400">({c.scenarioType})</span>
                </td>
                <td className="py-2">{c.oneYear !== null ? formatMoney(c.oneYear, currency) : '—'}</td>
                <td className="py-2">{c.fiveYear !== null ? formatMoney(c.fiveYear, currency) : '—'}</td>
                <td className="py-2">{c.tenYear !== null ? formatMoney(c.tenYear, currency) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
