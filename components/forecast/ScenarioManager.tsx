'use client';

import { useState } from 'react';

interface ScenarioRow {
  id: string;
  scenario_name: string;
  scenario_type: string;
  description: string | null;
  is_default: boolean;
}

const SCENARIO_TYPES = ['base', 'conservative', 'optimistic', 'custom', 'stress'] as const;

export function ScenarioManager({ initialScenarios }: { initialScenarios: ScenarioRow[] }) {
  const [scenarios, setScenarios] = useState(initialScenarios);
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof SCENARIO_TYPES)[number]>('custom');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createScenario() {
    if (!name.trim()) {
      setError('Scenario name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/forecast/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_name: name, scenario_type: type, description: description || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create scenario');
      setScenarios((prev) => [...prev, json.data]);
      setName('');
      setDescription('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-1">Scenario</th>
            <th className="py-1">Type</th>
            <th className="py-1">Description</th>
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="py-2 font-medium text-gray-800">{s.scenario_name}</td>
              <td className="py-2 capitalize text-gray-600">{s.scenario_type}</td>
              <td className="py-2 text-gray-500">{s.description ?? '—'}</td>
              <td className="py-2 text-right">{s.is_default && <span className="rounded-full bg-trust/10 px-2 py-0.5 text-xs font-semibold text-trust">Default</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="rounded border bg-gray-50 p-4">
        <p className="text-sm font-semibold text-gray-800">Add a scenario</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-48 rounded border px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="mt-1 rounded border px-3 py-2 text-sm">
              {SCENARIO_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500">Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
          </div>
          <button onClick={createScenario} disabled={saving} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
            {saving ? 'Adding...' : 'Add scenario'}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-risk">{error}</p>}
      </div>
    </div>
  );
}
