'use client';

import { useState } from 'react';

interface AssumptionRow {
  key: string;
  category: string;
  value: number;
  valueType: string;
  unit: string | null;
  sourceType: string;
}

const SOURCE_LABEL: Record<string, string> = {
  user_override: 'Your override',
  scenario_default: 'Scenario default',
  country_default: 'Country default',
  global_default: 'Global default',
};

export function AssumptionsTable({ initialAssumptions, scenarioId }: { initialAssumptions: AssumptionRow[]; scenarioId: string }) {
  const [rows, setRows] = useState(initialAssumptions);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(row: AssumptionRow) {
    setEditingKey(row.key);
    setDraftValue(String(row.value));
    setError(null);
  }

  async function save(row: AssumptionRow) {
    const value = Number(draftValue);
    if (Number.isNaN(value)) {
      setError('Enter a valid number');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/forecast/assumptions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: null,
          assumption_category: row.category,
          assumption_key: row.key,
          assumption_value: value,
          value_type: row.valueType,
          unit: row.unit ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save assumption');
      setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value, sourceType: 'user_override' } : r)));
      setEditingKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {error && <p className="mb-3 text-sm text-risk">{error}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-1">Assumption</th>
            <th className="py-1">Category</th>
            <th className="py-1">Value</th>
            <th className="py-1">Source</th>
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t">
              <td className="py-2 font-medium text-gray-800">{row.key.replace(/_/g, ' ')}</td>
              <td className="py-2 text-gray-500">{row.category.replace(/_/g, ' ')}</td>
              <td className="py-2">
                {editingKey === row.key ? (
                  <input
                    type="number"
                    step="any"
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    className="w-28 rounded border px-2 py-1 text-sm"
                    autoFocus
                  />
                ) : (
                  <span>
                    {row.value}
                    {row.valueType === 'percentage' ? '%' : row.unit ? ` ${row.unit}` : ''}
                  </span>
                )}
              </td>
              <td className="py-2 text-gray-500">{SOURCE_LABEL[row.sourceType] ?? row.sourceType}</td>
              <td className="py-2 text-right">
                {editingKey === row.key ? (
                  <button onClick={() => save(row)} disabled={saving} className="text-xs font-semibold text-trust disabled:opacity-60">
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                ) : (
                  <button onClick={() => startEdit(row)} className="text-xs font-semibold text-gray-500 hover:text-trust">
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-gray-400">Scenario: {scenarioId}. Edits apply to this forecast profile and override the country/global default for every scenario until changed again.</p>
    </div>
  );
}
