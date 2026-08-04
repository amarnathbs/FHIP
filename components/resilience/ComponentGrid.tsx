'use client';

import { useState } from 'react';
import { resilienceBandStatus } from './ResilienceGauge';
import type { ResilienceComponentResult } from '@/lib/engines/resilience';

function titleCase(s: string): string {
  return s
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatValue(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v === null || v === undefined) return '—';
  return String(v);
}

const STATUS_RING: Record<string, string> = {
  good: 'ring-progress',
  caution: 'ring-caution',
  risk: 'ring-risk',
  neutral: 'ring-gray-200',
};

function ComponentCard({ component }: { component: ResilienceComponentResult }) {
  const [open, setOpen] = useState(false);
  const status = component.treatment === 'scored' ? resilienceBandStatus(component.statusBand) : 'neutral';
  return (
    <div className={`rounded-card border bg-white p-4 shadow-sm ring-1 ${STATUS_RING[status]}`}>
      <div className="flex items-start justify-between">
        <p className="font-medium text-gray-900">{component.label}</p>
        <p className="text-lg font-semibold text-gray-900">
          {component.rawScore !== null ? Math.round(component.rawScore) : '—'}
        </p>
      </div>
      <p className="mt-1 text-xs text-gray-500">Weight: {(component.weight * 100).toFixed(0)}%</p>
      <p className="mt-2 text-sm text-gray-600">{component.explanation}</p>
      {component.treatment !== 'scored' && (
        <p className="mt-1 text-xs font-medium text-caution">Data missing — this component isn&apos;t counted yet.</p>
      )}
      <button onClick={() => setOpen((o) => !o)} className="mt-3 text-xs font-medium text-trust hover:underline">
        {open ? 'Hide details' : 'View details'}
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t pt-3 text-xs">
          {Object.keys(component.currentValue).length > 0 && (
            <div>
              <p className="font-medium text-gray-700">Current</p>
              <ul className="mt-1 space-y-0.5 text-gray-600">
                {Object.entries(component.currentValue).map(([k, v]) => (
                  <li key={k} className="flex justify-between">
                    <span>{titleCase(k)}</span>
                    <span className="font-medium text-gray-900">{formatValue(v)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.keys(component.benchmarkValue).length > 0 && (
            <div>
              <p className="font-medium text-gray-700">Benchmark</p>
              <ul className="mt-1 space-y-0.5 text-gray-600">
                {Object.entries(component.benchmarkValue).map(([k, v]) => (
                  <li key={k} className="flex justify-between">
                    <span>{titleCase(k)}</span>
                    <span className="font-medium text-gray-900">{formatValue(v)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ComponentGrid({ components }: { components: ResilienceComponentResult[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {components.map((c) => (
        <ComponentCard key={c.code} component={c} />
      ))}
    </div>
  );
}
