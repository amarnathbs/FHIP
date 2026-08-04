'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

interface ForecastResultRow {
  entity_id: string;
  period_number: number;
  closing_value: number;
  currency: string;
}
interface ForecastExplanationRow {
  entity_id: string;
  explanation_text: string;
}
interface RunDetail {
  run: { id: string };
  results: ForecastResultRow[];
  explanations: ForecastExplanationRow[];
}

export function EntityForecastPanel({
  title,
  description,
  forecastType,
  emptyMessage,
  entities,
  scenarioId,
}: {
  title: string;
  description: string;
  forecastType: 'goal' | 'investment';
  emptyMessage: string;
  entities: { id: string; name: string; currency: 'AUD' | 'INR' }[];
  scenarioId?: string;
}) {
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
        body: JSON.stringify({ forecast_type: forecastType, scenario_id: scenarioId }),
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

  if (entities.length === 0) {
    return (
      <SectionCard title={title} description={description}>
        <p className="text-sm text-gray-500">{emptyMessage}</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={title} description={description}>
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
      </button>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {detail && (
        <div className="mt-6 space-y-4">
          {entities.map((entity) => {
            const oneYear = detail.results.find((r) => r.entity_id === entity.id && r.period_number === 12);
            const fiveYear = detail.results.find((r) => r.entity_id === entity.id && r.period_number === 60);
            const explanation = detail.explanations.find((e) => e.entity_id === entity.id);
            return (
              <div key={entity.id} className="rounded border p-4">
                <p className="text-sm font-semibold text-gray-800">{entity.name}</p>
                <div className="mt-2 flex flex-wrap gap-6 text-sm">
                  <span>1yr: {oneYear ? formatMoney(oneYear.closing_value, entity.currency) : '—'}</span>
                  <span>5yr: {fiveYear ? formatMoney(fiveYear.closing_value, entity.currency) : '—'}</span>
                </div>
                {explanation && <p className="mt-2 text-xs text-gray-500">{explanation.explanation_text}</p>}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
