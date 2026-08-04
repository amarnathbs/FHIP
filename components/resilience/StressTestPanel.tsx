'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { StressScenarioType } from '@/lib/engines/resilienceStress';

const SCENARIOS: { value: StressScenarioType; label: string }[] = [
  { value: 'income_stops', label: 'Primary income stops' },
  { value: 'income_falls_pct', label: 'Income falls 20%' },
  { value: 'unexpected_expense', label: 'Unexpected $5,000 expense' },
  { value: 'interest_rate_rise', label: 'Interest rates rise 1%' },
  { value: 'rental_vacancy', label: 'Rental property vacant' },
  { value: 'investment_market_decline', label: 'Markets fall 15%' },
  { value: 'currency_shock', label: 'Adverse 10% currency move' },
  { value: 'combined_severe', label: 'Combined severe scenario' },
];

interface ScenarioResponse {
  label: string;
  before: { overallScore: number; statusLabel: string; monthlySurplus: number; accessibleLiquidResources: number };
  after: { overallScore: number; statusLabel: string; monthlySurplus: number; accessibleLiquidResources: number };
  monthlyShortfall: number;
  survivalMonths: number | null;
  durationMonths: number | null;
}

export function StressTestPanel({ currency }: { currency: 'AUD' | 'INR' }) {
  const [loading, setLoading] = useState<StressScenarioType | null>(null);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scenario: StressScenarioType) {
    setLoading(scenario);
    setError(null);
    try {
      const res = await fetch('/api/resilience/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not run scenario');
      setResult(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(null);
    }
  }

  return (
    <SectionCard
      title="Stress-Test Your Resilience"
      description="Run a hypothetical shock to see how it would affect your resilience score and cash runway. Nothing here is saved."
    >
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.value}
            onClick={() => run(s.value)}
            disabled={loading !== null}
            className="rounded border px-3 py-2 text-sm text-gray-700 hover:border-trust hover:text-trust disabled:opacity-50"
          >
            {loading === s.value ? 'Calculating...' : s.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}
      {result && (
        <div className="mt-4 space-y-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="py-1">Measure</th>
                <th className="py-1">Current</th>
                <th className="py-1">Under shock</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="py-1">Resilience Score</td>
                <td className="py-1">
                  {result.before.overallScore} ({result.before.statusLabel})
                </td>
                <td className="py-1 font-semibold text-trust">
                  {result.after.overallScore} ({result.after.statusLabel})
                </td>
              </tr>
              <tr className="border-t">
                <td className="py-1">Monthly Surplus</td>
                <td className="py-1">{formatMoney(result.before.monthlySurplus, currency)}</td>
                <td className="py-1 font-semibold text-trust">{formatMoney(result.after.monthlySurplus, currency)}</td>
              </tr>
              <tr className="border-t">
                <td className="py-1">Accessible Liquid Resources</td>
                <td className="py-1">{formatMoney(result.before.accessibleLiquidResources, currency)}</td>
                <td className="py-1 font-semibold text-trust">{formatMoney(result.after.accessibleLiquidResources, currency)}</td>
              </tr>
            </tbody>
          </table>
          <div className="rounded-card border border-dashed bg-gray-50 p-4 text-sm">
            <p className="font-medium text-gray-800">Shock survival timeline</p>
            {result.survivalMonths === null ? (
              <p className="mt-1 text-gray-600">
                Your household would remain cash-flow positive under this shock — no reserve depletion expected.
              </p>
            ) : (
              <p className="mt-1 text-gray-600">
                At a shortfall of {formatMoney(result.monthlyShortfall, currency)}/month, your accessible liquid
                resources would run out in approximately <span className="font-semibold text-risk">{result.survivalMonths.toFixed(1)} months</span>.
              </p>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
