'use client';

import { useEffect, useState, useCallback } from 'react';

type Tab = 'sources' | 'datasets' | 'cohorts' | 'values' | 'target-ranges' | 'update-runs';

const TABS: { key: Tab; label: string }[] = [
  { key: 'sources', label: 'Sources' },
  { key: 'datasets', label: 'Datasets' },
  { key: 'cohorts', label: 'Cohorts' },
  { key: 'values', label: 'Observed Values' },
  { key: 'target-ranges', label: 'Planning Target Ranges' },
  { key: 'update-runs', label: 'Update / Audit Log' },
];

type Row = Record<string, unknown>;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function AdminBenchmarksClient() {
  const [tab, setTab] = useState<Tab>('datasets');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/benchmarks/${t}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Failed to load');
        setRows(null);
      } else {
        setRows(json.data);
      }
    } catch {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  async function activate(datasetId: string) {
    setBusyId(datasetId);
    try {
      const res = await fetch(`/api/admin/benchmarks/datasets/${datasetId}/activate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) alert(json.error ?? 'Could not activate');
      await load(tab);
    } finally {
      setBusyId(null);
    }
  }

  async function retire(datasetId: string) {
    setBusyId(datasetId);
    try {
      const res = await fetch(`/api/admin/benchmarks/datasets/${datasetId}/retire`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) alert(json.error ?? 'Could not retire');
      await load(tab);
    } finally {
      setBusyId(null);
    }
  }

  const columns = columnsFor(tab);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-trust">Benchmark Governance</h1>
        <p className="mt-1 text-sm text-gray-600">
          No benchmark becomes active without source metadata, dataset validation and admin approval (spec sections 20 and 26).
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-t px-3 py-2 text-sm ${tab === t.key ? 'border-b-2 border-trust font-semibold text-trust' : 'text-gray-500 hover:text-trust'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-card border border-risk bg-red-50 p-4 text-sm text-risk">
          {error === 'Admin access required' ? 'You do not have admin access to benchmark governance.' : error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {!loading && rows && (
        <div className="overflow-x-auto rounded-card border bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                    {c}
                  </th>
                ))}
                {tab === 'datasets' && <th className="px-3 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-4 text-center text-gray-400">
                    No rows yet.
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={(r.id as string) ?? i} className="border-t">
                  {columns.map((c) => (
                    <td key={c} className="max-w-xs truncate px-3 py-2" title={fmt(cell(r, c))}>
                      {fmt(cell(r, c))}
                    </td>
                  ))}
                  {tab === 'datasets' && (
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.data_status === 'active' ? (
                        <button
                          disabled={busyId === r.id}
                          onClick={() => retire(r.id as string)}
                          className="rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300 disabled:opacity-50"
                        >
                          Retire
                        </button>
                      ) : (
                        <button
                          disabled={busyId === r.id}
                          onClick={() => activate(r.id as string)}
                          className="rounded bg-trust px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
                        >
                          Activate
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function cell(r: Row, col: string): unknown {
  const map: Record<string, string> = {
    Source: 'source_name',
    Publisher: 'publisher',
    Status: col === 'Status' && 'status' in r ? 'status' : 'data_status',
    'Country/Quality': 'country_code',
    Dataset: 'dataset_name',
    Version: 'version',
    Class: 'benchmark_class',
    Evidence: 'evidence_level',
    'Effective From': 'effective_from',
    'Review Due': 'review_due_at',
    'Cohort Code': 'cohort_code',
    Tier: 'cohort_tier',
    Description: 'cohort_description',
    Metric: 'metric_definition_id',
    Statistic: 'statistic_type',
    Value: 'value_numeric',
    Currency: 'original_currency',
    'Band Label': 'band_label',
    'Band Tier': 'band_tier',
    Min: 'lower_bound',
    Max: 'upper_bound',
    Approval: 'approval_status',
    'Imported At': 'created_at',
  };
  const key = map[col];
  if (key && key in r) return r[key];
  // nested join fields
  const sources = r['benchmark_sources'] as Row | undefined;
  const datasets = r['benchmark_datasets'] as Row | undefined;
  const metricDefs = r['benchmark_metric_definitions'] as Row | undefined;
  if (col === 'Publisher' && sources) return sources.publisher ?? sources.source_name;
  if (col === 'Dataset' && datasets) return datasets.dataset_name;
  if (col === 'Metric' && metricDefs) return metricDefs.metric_name ?? metricDefs.metric_code;
  return r[col] ?? '—';
}

function columnsFor(tab: Tab): string[] {
  switch (tab) {
    case 'sources':
      return ['Source', 'Publisher', 'Status', 'country_code', 'citation_text', 'quality_rating'];
    case 'datasets':
      return ['Dataset', 'Version', 'Class', 'Evidence', 'Status', 'Effective From', 'Review Due', 'Publisher'];
    case 'cohorts':
      return ['Cohort Code', 'country_code', 'Tier', 'life_stage', 'household_type', 'Description'];
    case 'values':
      return ['Dataset', 'Metric', 'Statistic', 'Value', 'Currency', 'is_derived'];
    case 'target-ranges':
      return ['Metric', 'country_code', 'Band Label', 'Band Tier', 'Min', 'Max', 'evidence_level'];
    case 'update-runs':
      return ['Dataset', 'Approval', 'rows_imported', 'rows_rejected', 'Imported At'];
  }
}
