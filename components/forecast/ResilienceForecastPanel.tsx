'use client';

import { useState } from 'react';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { STRESS_SCENARIO_LABELS, type StressScenarioType } from '@/lib/engines/resilienceStress';

interface ForecastExplanationRow {
  explanation_text: string;
  calculation_inputs: {
    netWorthImpact: number;
    retirementImpact: number;
    depletionMonth: number | null;
    recoveryMonth: number | null;
    resilienceHealthBand?: string;
    resilienceHealthLabel?: string;
  };
}
interface RunDetail {
  run: { id: string };
  explanations: ForecastExplanationRow[];
}

const SCENARIO_OPTIONS: { value: StressScenarioType | 'none'; label: string }[] = [
  { value: 'none', label: 'Baseline (no stress)' },
  ...(Object.keys(STRESS_SCENARIO_LABELS) as StressScenarioType[]).map((key) => ({ value: key, label: STRESS_SCENARIO_LABELS[key] })),
];

const RESILIENCE_HEALTH_CLASS: Record<string, string> = {
  strong: 'bg-progress/10 text-progress',
  moderate: 'bg-caution/10 text-caution',
  weak: 'bg-caution/10 text-caution',
  critical: 'bg-risk/10 text-risk',
  unknown: 'bg-gray-100 text-gray-500',
};

export function ResilienceForecastPanel({ currency, scenarioId }: { currency: 'AUD' | 'INR'; scenarioId?: string }) {
  const [scenario, setScenario] = useState<StressScenarioType | 'none'>('none');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const runRes = await fetch('/api/forecast/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forecast_type: 'resilience', scenario_id: scenarioId, resilience_stress_scenario: scenario }),
      });
      const runJson = await runRes.json();
      if (!runRes.ok) throw new Error(runJson.error ?? 'Could not run forecast');
      const detailRes = await fetch(`/api/forecast/runs/${runJson.data.run.id}`);
      const detailJson = await detailRes.json();
      if (!detailRes.ok) throw new Error(detailJson.error ?? 'Could not load forecast results');
      setDetail(detailJson.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  const explanation = detail?.explanations[0];
  const inputs = explanation?.calculation_inputs;

  return (
    <SectionCard
      title="Resilience Forecast"
      description="Projects how your financial security develops over time, optionally starting from a stress scenario."
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500">Stress scenario</label>
          <select value={scenario} onChange={(e) => setScenario(e.target.value as StressScenarioType | 'none')} className="mt-1 rounded border px-3 py-2 text-sm">
            {SCENARIO_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
          {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {inputs && (
        <>
          {inputs.resilienceHealthLabel && (
            <span className={`mt-4 inline-block rounded-full px-3 py-1 text-sm font-semibold ${RESILIENCE_HEALTH_CLASS[inputs.resilienceHealthBand ?? 'unknown']}`}>
              Resilience Health: {inputs.resilienceHealthLabel}
            </span>
          )}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Net worth impact" value={formatMoney(inputs.netWorthImpact, currency)} />
            <Stat label="Retirement impact" value={formatMoney(inputs.retirementImpact, currency)} />
            <Stat label="Emergency-fund depletion" value={inputs.depletionMonth === null ? 'Not projected' : `Month ${inputs.depletionMonth}`} />
            <Stat label="Recovery" value={inputs.recoveryMonth === null ? 'Not projected' : `Month ${inputs.recoveryMonth}`} />
          </div>
          {explanation && <p className="mt-4 text-sm text-gray-600">{explanation.explanation_text}</p>}
        </>
      )}
    </SectionCard>
  );
}
