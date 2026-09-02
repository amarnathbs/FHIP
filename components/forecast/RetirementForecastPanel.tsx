'use client';

import { useState } from 'react';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

type TargetMethod = 'target_corpus' | 'desired_income' | 'expense_replacement';

interface RetirementExplanation {
  explanation_text: string;
  calculation_inputs: {
    balanceAtRetirement: number;
    requiredCorpus: number | null;
    fundingGap: number | null;
    readinessPct: number | null;
    status: string;
    contributionGap: number | null;
    monthsUntilRetirement: number | null;
  };
}
interface RunDetail {
  run: { id: string };
  explanations: RetirementExplanation[];
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  fully_funded: { label: 'Fully Funded', className: 'bg-progress/10 text-progress' },
  on_track: { label: 'On Track', className: 'bg-progress/10 text-progress' },
  minor_gap: { label: 'Minor Gap', className: 'bg-caution/10 text-caution' },
  material_gap: { label: 'Material Gap', className: 'bg-caution/10 text-caution' },
  high_risk: { label: 'High Risk', className: 'bg-risk/10 text-risk' },
  insufficient_information: { label: 'Insufficient Information', className: 'bg-gray-100 text-gray-500' },
};

export function RetirementForecastPanel({
  currency,
  currentBalance,
  scenarioId,
}: {
  currency: 'AUD' | 'INR';
  currentBalance: number;
  scenarioId?: string;
}) {
  const [method, setMethod] = useState<TargetMethod>('desired_income');
  const [desiredIncome, setDesiredIncome] = useState('60000');
  const [targetCorpus, setTargetCorpus] = useState('1000000');
  const [replacementPct, setReplacementPct] = useState('70');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { forecast_type: 'retirement', scenario_id: scenarioId, retirement_target_method: method };
      if (method === 'target_corpus') body.retirement_target_corpus = Number(targetCorpus) || 0;
      if (method === 'desired_income') body.retirement_desired_annual_income = Number(desiredIncome) || 0;
      if (method === 'expense_replacement') body.retirement_replacement_percentage = Number(replacementPct) || 0;

      const runRes = await fetch('/api/forecast/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
  const statusInfo = inputs ? STATUS_LABEL[inputs.status] : null;

  return (
    <SectionCard
      title="Retirement Forecast"
      description="Projected retirement readiness using your current retirement account balances and contributions."
      // Module 11.5 (spec sections 39-41). Explains the certified retirement
      // forecast that is already displayed. The panel's own target-method and
      // input controls are untouched and are NOT reachable from the
      // explanation — 11.5 never runs an alternative scenario.
      explain={{ targetCode: 'FORECAST_RETIREMENT', accessibleLabel: 'Explain what is affecting your retirement forecast' }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500">Target method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as TargetMethod)} className="mt-1 rounded border px-3 py-2 text-sm">
            <option value="desired_income">Desired annual income</option>
            <option value="target_corpus">Target corpus</option>
            <option value="expense_replacement">Expense replacement</option>
          </select>
        </div>
        {method === 'desired_income' && (
          <div>
            <label className="block text-xs text-gray-500">Desired annual retirement income</label>
            <input type="number" min="0" value={desiredIncome} onChange={(e) => setDesiredIncome(e.target.value)} className="mt-1 w-40 rounded border px-3 py-2 text-sm" />
          </div>
        )}
        {method === 'target_corpus' && (
          <div>
            <label className="block text-xs text-gray-500">Target retirement corpus</label>
            <input type="number" min="0" value={targetCorpus} onChange={(e) => setTargetCorpus(e.target.value)} className="mt-1 w-40 rounded border px-3 py-2 text-sm" />
          </div>
        )}
        {method === 'expense_replacement' && (
          <div>
            <label className="block text-xs text-gray-500">Replacement % of current essential expenses</label>
            <input type="number" min="0" max="100" value={replacementPct} onChange={(e) => setReplacementPct(e.target.value)} className="mt-1 w-32 rounded border px-3 py-2 text-sm" />
          </div>
        )}
        <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
          {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {inputs && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {statusInfo && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusInfo.className}`}>{statusInfo.label}</span>}
            {inputs.readinessPct !== null && <span className="text-sm text-gray-600">{inputs.readinessPct.toFixed(0)}% funded</span>}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Current balance" value={formatMoney(currentBalance, currency)} />
            <Stat label="Projected balance at retirement" value={formatMoney(inputs.balanceAtRetirement, currency)} />
            <Stat label="Required corpus" value={inputs.requiredCorpus !== null ? formatMoney(inputs.requiredCorpus, currency) : '—'} />
            <Stat label="Funding gap" value={inputs.fundingGap !== null ? formatMoney(Math.max(0, inputs.fundingGap), currency) : '—'} />
          </div>
          {explanation && <p className="mt-4 text-sm text-gray-600">{explanation.explanation_text}</p>}
        </>
      )}
    </SectionCard>
  );
}
