'use client';

import { useEffect, useState } from 'react';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

// Fund analytics health (NAV2 monitoring). Aggregate-only: every figure comes from nav2_monitoring_snapshot(), which
// suppresses any figure derived from user holdings below 5 (state `suppressed`, the fixed label shown verbatim) and reports
// an absent source as `unavailable`. This screen never turns either into a 0. Errors are shown as errors.

interface Cell {
  state: 'ok' | 'suppressed' | 'unavailable';
  value?: unknown;
  label?: string;
}

const LABELS: Array<[string, string]> = [
  ['held_instruments', 'Funds held by at least one user'],
  ['held_instruments_without_any_nav', 'Held funds with no price history at all'],
  ['held_instruments_with_stale_nav', 'Held funds whose latest price is more than 7 days old'],
  ['hydration_instruments_failing', 'Funds whose price fetch is failing'],
  ['hydration_repeated_identifier_failures', 'Funds the price source cannot identify'],
  ['hydration_oldest_attempt_age_days', 'Age of the oldest price-fetch attempt (days)'],
  ['nav_corrections_last_7_days', 'Price corrections in the last 7 days'],
  ['correction_processing_lag_seconds', 'Oldest unprocessed correction (seconds)'],
  ['cache_entries', 'Cached analytics entries'],
  ['cache_entries_invalidated', 'Cached entries invalidated by a correction'],
  ['reports_last_30_days', 'Fund analytics reports generated in the last 30 days'],
  ['benchmarks_in_catalogue', 'Benchmarks in the catalogue'],
  ['benchmarks_with_any_series', 'Benchmarks with any published series'],
];
const STORAGE: Array<[string, string]> = [
  ['nav_rows_total', 'Price rows stored, all funds'],
  ['nav_rows_of_held_instruments', 'Price rows of held funds'],
  ['nav_rows_non_held_before_policy_changeover', 'Price rows of funds nobody holds, from before the retention policy'],
];

function show(c: Cell | undefined): string {
  if (!c) return 'Not available.';
  if (c.state === 'ok') return typeof c.value === 'number' ? c.value.toLocaleString('en-IN') : String(c.value ?? '');
  return c.label ?? (c.state === 'suppressed' ? 'Insufficient data to display safely.' : 'Not available.');
}

export default function Nav2MonitoringClient() {
  const [snap, setSnap] = useState<Record<string, unknown> | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/investment-intelligence/nav2-monitoring');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(`${r.status}: ${j.error ?? 'Could not load the snapshot'}`);
        else if (j.data?.state === 'unavailable') setUnavailable(j.data.reason);
        else setSnap(j.data.snapshot);
      } catch {
        if (!cancelled) setError('Could not load the snapshot.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cell = (k: string): Cell | undefined => snap?.[k] as Cell | undefined;
  const storage = (snap?.storage ?? {}) as Record<string, Cell>;
  const series = ((snap?.risk_free_series as { value?: Array<Record<string, unknown>> } | undefined)?.value ?? []) as Array<Record<string, unknown>>;
  const states = cell('result_states_last_30_days');

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Fund analytics health</h1>
      <p style={{ opacity: 0.8, marginTop: '0.25rem' }}>Aggregate counts only. A figure that comes from users&apos; holdings and is below 5 is withheld, never shown as a number.</p>
      {error && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      )}
      {unavailable && (
        <p>
          <strong>Unavailable.</strong> {unavailable}
        </p>
      )}
      {snap && (
        <>
          <table style={{ width: '100%', marginTop: '1rem' }}>
            <caption style={{ textAlign: 'left', opacity: 0.7 }}>Price history, corrections, cache and reports</caption>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th scope="col">Measure</th>
                <th scope="col" className={NUM_HEADER_CLASS}>Value</th>
              </tr>
            </thead>
            <tbody>
              {LABELS.map(([k, label]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td className={NUM_CELL_CLASS}>{show(cell(k))}</td>
                </tr>
              ))}
              {STORAGE.map(([k, label]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td className={NUM_CELL_CLASS}>{show(storage[k])}</td>
                </tr>
              ))}
              <tr>
                <td>Result states across reports, last 30 days</td>
                <td className={NUM_CELL_CLASS}>{states?.state === 'ok' ? JSON.stringify(states.value) : show(states)}</td>
              </tr>
            </tbody>
          </table>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '1.5rem' }}>Risk-free rate series</h2>
          {series.length === 0 ? (
            <p>No risk-free series is set up.</p>
          ) : (
            <ul>
              {series.map((x) => (
                <li key={String(x.series_id)}>
                  {String(x.series_id)}: {x.enabled ? 'on' : 'OFF'}; {x.days_since === null || x.days_since === undefined ? 'no data loaded' : `${String(x.days_since)} day(s) since ${x.cadence === 'policy_change' ? 'last confirmed complete' : 'the last auction'}; stale after ${String(x.stale_after_days)}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
