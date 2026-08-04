'use client';

import { useState } from 'react';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

interface ForecastResultRow {
  period_number: number;
  closing_value: number;
  metadata: { foreignCurrency?: 'AUD' | 'INR'; fxRate?: number } | null;
}
interface ForecastExplanationRow {
  explanation_text: string;
  calculation_inputs: {
    netForeignWealthLocal: number;
    fxRateAudInr: number;
    localReturnInReportingCurrency: number;
    currencyGainLoss: number;
    totalReportingReturn: number;
  };
}
interface RunDetail {
  run: { id: string };
  results: ForecastResultRow[];
  explanations: ForecastExplanationRow[];
}

function pickPeriod(results: ForecastResultRow[], months: number) {
  return results.find((r) => r.period_number === months) ?? null;
}

export function CrossBorderForecastPanel({ currency, scenarioId }: { currency: 'AUD' | 'INR'; scenarioId?: string }) {
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
        body: JSON.stringify({ forecast_type: 'cross_border', scenario_id: scenarioId }),
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

  const foreignCurrency = currency === 'AUD' ? 'INR' : 'AUD';
  const oneYear = detail ? pickPeriod(detail.results, 12) : null;
  const fiveYear = detail ? pickPeriod(detail.results, 60) : null;
  const tenYear = detail ? pickPeriod(detail.results, 120) : null;
  const topExplanation = detail?.explanations[0] ?? null;
  const inputs = topExplanation?.calculation_inputs;

  return (
    <SectionCard
      title="Cross-Border Forecast"
      description={`Projects your ${foreignCurrency}-denominated assets, investments, liabilities and retirement accounts, converted to ${currency} using a forecast FX rate assumption.`}
    >
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
      </button>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {detail && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={`Net foreign wealth (${foreignCurrency})`} value={inputs ? formatMoney(inputs.netForeignWealthLocal, foreignCurrency) : '—'} />
            <Stat label={`Forecast in 1 year (${currency})`} value={oneYear ? formatMoney(oneYear.closing_value, currency) : '—'} />
            <Stat label={`Forecast in 5 years (${currency})`} value={fiveYear ? formatMoney(fiveYear.closing_value, currency) : '—'} />
            <Stat label={`Forecast in 10 years (${currency})`} value={tenYear ? formatMoney(tenYear.closing_value, currency) : '—'} />
          </div>
          {inputs && (
            <div className="mt-4 flex flex-wrap gap-6 text-sm">
              <span>Local-currency return: {formatMoney(inputs.localReturnInReportingCurrency, currency)}</span>
              <span className={inputs.currencyGainLoss >= 0 ? 'text-progress' : 'text-risk'}>
                Currency gain/loss: {formatMoney(inputs.currencyGainLoss, currency)}
              </span>
              <span>FX rate used: {inputs.fxRateAudInr} INR per AUD</span>
            </div>
          )}
          {topExplanation && <p className="mt-4 text-sm text-gray-600">{topExplanation.explanation_text}</p>}
          <p className="mt-4 text-xs text-gray-400">
            This is not tax, residency or transfer advice. Cross-border tax and reporting rules can be complex — consult a qualified
            professional before acting on foreign asset positions.
          </p>
        </>
      )}
    </SectionCard>
  );
}
