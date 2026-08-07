'use client';

import { useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

interface ForecastExplanationRow {
  entity_id: string;
  explanation_text: string;
  calculation_inputs: {
    payoffMonth: number | null;
    totalInterest: number;
    acceleratedPayoffMonth: number | null;
    acceleratedTotalInterest: number | null;
    // FHIP-FC-DEBT-001/002/003
    isNegativeAmortization?: boolean;
    riskLevel?: 'high' | 'medium' | 'low';
    curePayment?: number;
    payoffPayment3yr?: number;
    payoffPayment5yr?: number;
  };
}
interface RunDetail {
  run: { id: string };
  explanations: ForecastExplanationRow[];
}

const RISK_LABEL: Record<string, { label: string; className: string }> = {
  high: { label: 'High Risk', className: 'bg-risk/10 text-risk' },
  medium: { label: 'Medium Risk', className: 'bg-caution/10 text-caution' },
  low: { label: 'Low Risk', className: 'bg-progress/10 text-progress' },
};

export function DebtForecastPanel({
  liabilities,
  scenarioId,
}: {
  liabilities: { id: string; name: string; currency: 'AUD' | 'INR' }[];
  scenarioId?: string;
}) {
  const [additionalRepayment, setAdditionalRepayment] = useState('0');
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
        body: JSON.stringify({ forecast_type: 'debt', scenario_id: scenarioId, additional_monthly_repayment: Number(additionalRepayment) || 0 }),
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

  if (liabilities.length === 0) {
    return (
      <SectionCard title="Debt Forecasts" description="Projected payoff date and total interest for each liability.">
        <p className="text-sm text-gray-500">No active liabilities — nothing to forecast.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Debt Forecasts"
      description="Projected payoff date and total interest for each liability at the current repayment, with an optional additional monthly repayment comparison."
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500">Additional monthly repayment (optional)</label>
          <input
            type="number"
            min="0"
            value={additionalRepayment}
            onChange={(e) => setAdditionalRepayment(e.target.value)}
            className="mt-1 w-40 rounded border px-3 py-2 text-sm"
          />
        </div>
        <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
          {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {detail && (
        <div className="mt-6 space-y-4">
          {liabilities.map((liability) => {
            const explanation = detail.explanations.find((e) => e.entity_id === liability.id);
            const inputs = explanation?.calculation_inputs;
            return (
              <div key={liability.id} className="rounded border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-gray-800">{liability.name}</p>
                  {inputs?.riskLevel && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RISK_LABEL[inputs.riskLevel]?.className ?? ''}`}>
                      {RISK_LABEL[inputs.riskLevel]?.label ?? inputs.riskLevel}
                    </span>
                  )}
                </div>
                {inputs && (
                  <div className="mt-2 flex flex-wrap gap-6 text-sm">
                    <span>Payoff: {inputs.payoffMonth === null ? 'beyond horizon' : inputs.payoffMonth === 0 ? 'already paid off' : `month ${inputs.payoffMonth}`}</span>
                    <span>Total interest: {formatMoney(inputs.totalInterest, liability.currency)}</span>
                    {inputs.acceleratedPayoffMonth !== null && inputs.acceleratedPayoffMonth !== undefined && (
                      <span>With extra repayment: month {inputs.acceleratedPayoffMonth}</span>
                    )}
                  </div>
                )}
                {inputs?.isNegativeAmortization && (
                  <div className="mt-3 rounded border border-risk/30 bg-risk/5 p-3 text-sm">
                    <p className="font-semibold text-risk">Balance is growing — repayment doesn&apos;t cover accruing interest</p>
                    <div className="mt-1 flex flex-wrap gap-6 text-xs text-gray-700">
                      {inputs.curePayment !== undefined && <span>Stop growth: {formatMoney(inputs.curePayment, liability.currency)}/mo</span>}
                      {inputs.payoffPayment3yr !== undefined && <span>Clear in 3yr: {formatMoney(inputs.payoffPayment3yr, liability.currency)}/mo</span>}
                      {inputs.payoffPayment5yr !== undefined && <span>Clear in 5yr: {formatMoney(inputs.payoffPayment5yr, liability.currency)}/mo</span>}
                    </div>
                  </div>
                )}
                {explanation && <p className="mt-2 text-xs text-gray-500">{explanation.explanation_text}</p>}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
