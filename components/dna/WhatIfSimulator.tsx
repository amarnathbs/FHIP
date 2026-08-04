'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { SCENARIO_LABELS, type ScenarioType } from '@/lib/engines/whatIf';

interface ScenarioSummary {
  primaryProfileCode: string | null;
  primaryScore: number | null;
  confidence: number;
}

const SCENARIOS = Object.keys(SCENARIO_LABELS) as ScenarioType[];

export function DnaWhatIfSimulator({ archetypes }: { archetypes: Record<string, { profile_name: string }> }) {
  const [loading, setLoading] = useState<ScenarioType | null>(null);
  const [result, setResult] = useState<{ before: ScenarioSummary; after: ScenarioSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scenario: ScenarioType) {
    setLoading(scenario);
    setError(null);
    try {
      const res = await fetch('/api/intelligence/financial-dna/scenario', {
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

  const label = (code: string | null) => (code ? archetypes[code]?.profile_name ?? code : '—');

  return (
    <SectionCard
      title="What-If DNA Simulator"
      description="Test how a change might shift your Financial DNA. This is a simulated result only and is never saved unless you change your actual data."
    >
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s}
            onClick={() => run(s)}
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
              <th className="py-1">Result</th>
              <th className="py-1">Current</th>
              <th className="py-1">Scenario</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="py-1">Primary DNA</td>
              <td className="py-1">{label(result.before.primaryProfileCode)}</td>
              <td className="py-1 font-semibold text-trust">{label(result.after.primaryProfileCode)}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Compatibility</td>
              <td className="py-1">{result.before.primaryScore?.toFixed(0) ?? '—'}</td>
              <td className="py-1 font-semibold text-trust">{result.after.primaryScore?.toFixed(0) ?? '—'}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1">Confidence</td>
              <td className="py-1">{result.before.confidence.toFixed(0)}%</td>
              <td className="py-1 font-semibold text-trust">{result.after.confidence.toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
