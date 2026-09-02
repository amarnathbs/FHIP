'use client';

import { useState } from 'react';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { ContextualExplain } from '@/components/aiExplain/ContextualExplain';

interface ForecastResultRow {
  period_number: number;
  period_date: string;
  closing_value: number;
}
interface ForecastExplanationRow {
  title: string;
  explanation_text: string;
  calculation_formula: string;
}
interface RunDetail {
  run: { id: string; status: string; created_at: string };
  results: ForecastResultRow[];
  explanations: ForecastExplanationRow[];
}
interface PlannedEventRow {
  monthIndex: string;
  amount: string;
  description: string;
}

function pickPeriod(results: ForecastResultRow[], months: number) {
  return results.find((r) => r.period_number === months) ?? null;
}

export function RunForecastPanel({
  currency,
  currentNetWorth,
  initialDetail,
  scenarioId,
}: {
  currency: 'AUD' | 'INR';
  currentNetWorth: number;
  initialDetail: RunDetail | null;
  scenarioId?: string;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<PlannedEventRow[]>([]);
  const [showEvents, setShowEvents] = useState(false);

  function addEventRow() {
    setEvents((prev) => [...prev, { monthIndex: '12', amount: '', description: '' }]);
  }
  function updateEventRow(index: number, patch: Partial<PlannedEventRow>) {
    setEvents((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }
  function removeEventRow(index: number) {
    setEvents((prev) => prev.filter((_, i) => i !== index));
  }

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const plannedEvents = events
        .filter((e) => e.amount !== '' && e.description.trim() !== '')
        .map((e) => ({ month_index: Number(e.monthIndex) || 1, amount: Number(e.amount) || 0, description: e.description.trim() }));

      const runRes = await fetch('/api/forecast/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forecast_type: 'net_worth',
          scenario_id: scenarioId,
          planned_events: plannedEvents.length > 0 ? plannedEvents : undefined,
        }),
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

  const oneYear = detail ? pickPeriod(detail.results, 12) : null;
  const fiveYear = detail ? pickPeriod(detail.results, 60) : null;
  const tenYear = detail ? pickPeriod(detail.results, 120) : null;
  const topExplanation = detail?.explanations[0] ?? null;

  return (
    <SectionCard
      title="Net Worth Forecast"
      description="A deterministic, monthly-compounded projection of your net worth using your current balances and forecast assumptions."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={generate}
          disabled={loading}
          className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60"
        >
          {loading ? 'Calculating...' : detail ? 'Regenerate forecast' : 'Generate forecast'}
        </button>
        <button onClick={() => setShowEvents((s) => !s)} className="text-xs font-semibold text-gray-500 hover:text-trust">
          {showEvents ? 'Hide planned events' : `Planned events${events.length > 0 ? ` (${events.length})` : ''}`}
        </button>
      </div>

      {showEvents && (
        <div className="mt-4 space-y-2 rounded border bg-gray-50 p-4">
          <p className="text-xs text-gray-500">
            Add one-off future inflows (e.g. inheritance, bonus) or outflows (e.g. planned purchase — use a negative amount) at a specific
            forecast month.
          </p>
          {events.map((e, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min="1"
                value={e.monthIndex}
                onChange={(ev) => updateEventRow(i, { monthIndex: ev.target.value })}
                placeholder="Month"
                className="w-20 rounded border px-2 py-1 text-sm"
              />
              <input
                type="number"
                value={e.amount}
                onChange={(ev) => updateEventRow(i, { amount: ev.target.value })}
                placeholder="Amount (+/-)"
                className="w-32 rounded border px-2 py-1 text-sm"
              />
              <input
                type="text"
                value={e.description}
                onChange={(ev) => updateEventRow(i, { description: ev.target.value })}
                placeholder="Description"
                className="flex-1 rounded border px-2 py-1 text-sm"
              />
              <button onClick={() => removeEventRow(i)} className="text-xs text-risk">
                Remove
              </button>
            </div>
          ))}
          <button onClick={addEventRow} className="text-xs font-semibold text-trust">
            + Add event
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-risk">{error}</p>}

      {detail && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Current net worth" value={formatMoney(currentNetWorth, currency)} />
            <Stat label="Forecast in 1 year" value={oneYear ? formatMoney(oneYear.closing_value, currency) : '—'} />
            <div data-testid="forecast-net-worth-5y">
              <Stat label="Forecast in 5 years" value={fiveYear ? formatMoney(fiveYear.closing_value, currency) : '—'} />
            </div>
            <Stat label="Forecast in 10 years" value={tenYear ? formatMoney(tenYear.closing_value, currency) : '—'} />
          </div>
          {topExplanation && (
            <div className="mt-6 rounded border bg-gray-50 p-4">
              <p className="text-sm font-semibold text-gray-800">How this was calculated</p>
              <p className="mt-1 text-sm text-gray-600">{topExplanation.explanation_text}</p>
              <p className="mt-2 font-mono text-xs text-gray-500">{topExplanation.calculation_formula}</p>
            </div>
          )}
          {/* Module 11.5 (spec sections 39-41). Explains the CURRENTLY
              DISPLAYED base-case forecast. It accepts no assumption, rate,
              retirement age or scenario input — there is no such field on the
              contextual request — so it can never run a new projection. The
              stored commentary it surfaces preserves the forecast's own
              uncertainty wording (spec section 40); nothing here rewrites it. */}
          <ContextualExplain
            targetCode="FORECAST_SUMMARY"
            accessibleLabel="Explain what your net worth forecast means"
            className="mt-4 inline-flex min-h-[32px] items-center gap-1 text-sm font-medium text-ai hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
          />
        </>
      )}
    </SectionCard>
  );
}
