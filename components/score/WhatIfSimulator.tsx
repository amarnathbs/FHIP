'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { SCENARIO_LABELS, type ScenarioType } from '@/lib/engines/whatIf';

interface ScenarioSummary {
  score: number;
  savingsRate: number | null;
  debtServiceRatio: number | null;
  emergencyFundMonths: number | null;
  monthlySurplus: number;
}

const SCENARIOS = Object.keys(SCENARIO_LABELS) as ScenarioType[];

function fmtPercent(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}
function fmtMonths(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} mo`;
}

export function WhatIfSimulator({ currency }: { currency: 'AUD' | 'INR' }) {
  const [loading, setLoading] = useState<ScenarioType | null>(null);
  const [result, setResult] = useState<{ before: ScenarioSummary; after: ScenarioSummary; scenario: ScenarioType } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  async function runScenario(scenario: ScenarioType) {
    setLoading(scenario);
    setError(null);
    try {
      const res = await fetch('/api/health-score/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not run scenario');
      setResult({ before: json.data.before, after: json.data.after, scenario });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(null);
    }
  }

  return (
    <SectionCard
      title="What-If Simulator"
      description="Test a scenario to see how it would change your score. Nothing here is saved unless you act on it in your actual data."
    >
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s}
            onClick={() => runScenario(s)}
            disabled={loading !== null}
            className="rounded border px-3 py-2 text-sm text-gray-700 hover:border-trust hover:text-trust disabled:opacity-50"
          >
            {loading === s ? 'Calculating...' : SCENARIO_LABELS[s]}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}
      {result && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="py-1">Measure</th>
              <th className="py-1">Current</th>
              <th className="py-1">Scenario</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="py-1">Financial Health Score</td>
              <td className="py-1">{result.before.score}</td>
              <td className="py-1 font-semibold text-trust">{result.after.score}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Savings Rate</td>
              <td className="py-1">{fmtPercent(result.before.savingsRate)}</td>
              <td className="py-1 font-semibold text-trust">{fmtPercent(result.after.savingsRate)}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Debt Service Ratio</td>
              <td className="py-1">{fmtPercent(result.before.debtServiceRatio)}</td>
              <td className="py-1 font-semibold text-trust">{fmtPercent(result.after.debtServiceRatio)}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Emergency Coverage</td>
              <td className="py-1">{fmtMonths(result.before.emergencyFundMonths)}</td>
              <td className="py-1 font-semibold text-trust">{fmtMonths(result.after.emergencyFundMonths)}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Monthly Surplus</td>
              <td className="py-1">{formatMoney(result.before.monthlySurplus, currency)}</td>
              <td className="py-1 font-semibold text-trust">{formatMoney(result.after.monthlySurplus, currency)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
