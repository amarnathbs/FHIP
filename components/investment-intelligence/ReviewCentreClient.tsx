'use client';

import { useEffect, useState, useCallback } from 'react';

// R9 — Review Centre UX (spec sections 56, 59, 134). Sections mirror the
// spec's suggested layout: Overview (severity counts) + a filterable list.
// Values are grouped by review_type (goal/portfolio/performance/sip/
// tax_cost/data_quality) rather than re-derived — every figure shown is
// exactly what the API returned, never recomputed client-side (spec section
// 40, no client-side "AI" or heuristic reclassification).

interface ReviewItem {
  id: string;
  review_type: string;
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  compliance_classification: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  source_module: string;
  as_of_date: string;
  status: string;
  created_at: string;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function ReviewCentreClient() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'open' | 'acknowledged' | 'resolved' | 'dismissed'>('open');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/review?status=${status}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load review items');
      setItems(json.data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load review items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await load(statusFilter);
      if (cancelled) return;
      void result;
    })();
    return () => {
      cancelled = true;
    };
  }, [statusFilter, load]);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } finally {
      setRefreshing(false);
    }
  }

  async function act(id: string, action: 'acknowledge' | 'dismiss') {
    await fetch(`/api/investment-intelligence/review/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    await load(statusFilter);
  }

  const bySeverity = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] ?? 0) + 1 }), {});

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {(['open', 'acknowledged', 'resolved', 'dismissed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-sm ${statusFilter === s ? 'bg-ink text-white' : 'bg-gray-100 text-muted'}`}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button onClick={refresh} disabled={refreshing} className="ml-auto rounded-md border px-3 py-1 text-sm text-muted disabled:opacity-50">
          {refreshing ? 'Refreshing…' : 'Refresh observations'}
        </button>
      </div>

      {statusFilter === 'open' && (
        <div className="mb-4 flex gap-3 text-sm">
          {(['high', 'medium', 'low', 'info'] as const).map((sev) => (
            <span key={sev} className="rounded-md bg-gray-50 px-2 py-1">
              {SEVERITY_LABEL[sev]}: {counts[sev] ?? 0}
            </span>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && bySeverity.length === 0 && <p className="text-sm text-muted">No {statusFilter} review items right now.</p>}

      <ul className="space-y-3">
        {bySeverity.map((item) => (
          <li key={item.id} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${item.severity === 'high' ? 'bg-red-100 text-red-800' : item.severity === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>
                    {SEVERITY_LABEL[item.severity]}
                  </span>
                  <span className="text-xs uppercase tracking-wide text-muted">{item.review_type.replace('_', ' ')}</span>
                  <span className="text-xs text-muted">· {item.compliance_classification}</span>
                </div>
                <h3 className="mt-1 font-medium text-ink">{item.title}</h3>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
                <p className="mt-2 text-xs text-muted">
                  Source: {item.source_module.replace(/_/g, ' ')} · as of {item.as_of_date}
                </p>
              </div>
              {statusFilter === 'open' && (
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => act(item.id, 'acknowledge')} className="rounded-md border px-2 py-1 text-xs text-muted">
                    Acknowledge
                  </button>
                  <button onClick={() => act(item.id, 'dismiss')} className="rounded-md border px-2 py-1 text-xs text-muted">
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
