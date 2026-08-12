'use client';

import { Fragment, useState } from 'react';
import { formatDateTimeShort } from '@/lib/engines/date';

interface RunRow {
  id: string;
  forecast_type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}
interface ForecastResultRow {
  period_number: number;
  closing_value: number;
  currency: string;
}

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  running: 'Running',
  pending: 'Pending',
  failed: 'Failed',
};

export function ForecastHistoryList({ initialRuns, currency }: { initialRuns: RunRow[]; currency: 'AUD' | 'INR' }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ results: ForecastResultRow[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle(runId: string) {
    if (expandedId === runId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(runId);
    setDetail(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/forecast/runs/${runId}`);
      const json = await res.json();
      if (res.ok) setDetail(json.data);
    } finally {
      setLoading(false);
    }
  }

  if (initialRuns.length === 0) {
    return <p className="text-sm text-gray-500">No forecasts have been run yet. Generate one from Forecast Overview.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-gray-500">
        <tr>
          <th className="py-1">Run date</th>
          <th className="py-1">Type</th>
          <th className="py-1">Status</th>
          <th className="py-1"></th>
        </tr>
      </thead>
      <tbody>
        {initialRuns.map((run) => (
          <Fragment key={run.id}>
            <tr className="border-t">
              <td className="py-2">{formatDateTimeShort(run.created_at, currency)}</td>
              <td className="py-2 capitalize">{run.forecast_type.replace(/_/g, ' ')}</td>
              <td className="py-2">
                {STATUS_LABEL[run.status] ?? run.status}
                {run.status === 'failed' && run.error_message && <span className="ml-1 text-xs text-risk">({run.error_message})</span>}
              </td>
              <td className="py-2 text-right">
                {run.status === 'completed' && (
                  <button onClick={() => toggle(run.id)} className="text-xs font-semibold text-trust">
                    {expandedId === run.id ? 'Hide' : 'View'}
                  </button>
                )}
              </td>
            </tr>
            {expandedId === run.id && (
              <tr className="border-t bg-gray-50">
                <td colSpan={4} className="py-3">
                  {loading && <p className="text-xs text-gray-500">Loading...</p>}
                  {detail && (
                    <div className="flex flex-wrap gap-6">
                      {[12, 60, 120].map((m) => {
                        const point = detail.results.find((r) => r.period_number === m);
                        return (
                          <div key={m}>
                            <p className="text-xs text-gray-500">Month {m}</p>
                            <p className="font-semibold text-gray-800">
                              {point ? `${point.closing_value.toLocaleString()} ${point.currency}` : '—'}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
