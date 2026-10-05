'use client';

import { useCallback, useEffect, useState } from 'react';
import { ActionMessage, Btn, Notice, Panel, ScrollTable, Td, Th } from '@/components/admin/benchmarkData/ui';
import { describeFailure } from '@/components/admin/riskFreeFormLogic';

// Fund analytics health (NAV2 monitoring). Aggregate-only: every figure comes from nav2_monitoring_snapshot(), which
// suppresses any figure derived from user holdings below 5 (state `suppressed`, the fixed label shown verbatim) and reports
// an absent source as `unavailable`. This screen never turns either into a 0. Errors are shown as errors, next to the
// Refresh button that asked for them (shared admin kit: real buttons, focus rings, phone-width layout).

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
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/investment-intelligence/nav2-monitoring');
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setMessage({ kind: 'error', text: describeFailure(r.status, j, 'Could not load the snapshot.') });
      } else if (j?.data?.state === 'unavailable') {
        setUnavailable(j.data.reason);
        setSnap(null);
        setMessage(null);
      } else {
        setUnavailable(null);
        setSnap(j.data.snapshot);
        setMessage(isRefresh ? { kind: 'ok', text: 'The figures were refreshed.' } : null);
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not load the snapshot. Check your connection and try again.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const cell = (k: string): Cell | undefined => snap?.[k] as Cell | undefined;
  const storage = (snap?.storage ?? {}) as Record<string, Cell>;
  const series = ((snap?.risk_free_series as { value?: Array<Record<string, unknown>> } | undefined)?.value ?? []) as Array<Record<string, unknown>>;
  const states = cell('result_states_last_30_days');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Fund analytics health</h1>
        <p className="mt-1 text-sm text-muted">Aggregate counts only. A figure that comes from users&apos; holdings and is below 5 is withheld, never shown as a number.</p>
        <div className="mt-3">
          <Btn kind="secondary" busy={loading} onClick={() => void load(true)}>
            Refresh the figures
          </Btn>
        </div>
        <ActionMessage message={message} />
      </header>
      {unavailable && (
        <Notice tone="warn" live="alert" title="Unavailable">
          {unavailable}
        </Notice>
      )}
      {snap && (
        <>
          <Panel title="Price history, corrections, cache and reports">
            <ScrollTable label="Price history, corrections, cache and reports" minWidth="min-w-[480px]">
              <thead>
                <tr>
                  <Th>Measure</Th>
                  <Th num>Value</Th>
                </tr>
              </thead>
              <tbody>
                {LABELS.map(([k, label]) => (
                  <tr key={k}>
                    <Td>{label}</Td>
                    <Td num>{show(cell(k))}</Td>
                  </tr>
                ))}
                {STORAGE.map(([k, label]) => (
                  <tr key={k}>
                    <Td>{label}</Td>
                    <Td num>{show(storage[k])}</Td>
                  </tr>
                ))}
                <tr>
                  <Td>Result states across reports, last 30 days</Td>
                  <Td num>{states?.state === 'ok' ? JSON.stringify(states.value) : show(states)}</Td>
                </tr>
              </tbody>
            </ScrollTable>
          </Panel>
          <Panel title="Risk-free rate series">
            {series.length === 0 ? (
              <p className="text-sm text-muted">No risk-free series is set up.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-6 text-sm text-ink">
                {series.map((x) => (
                  <li key={String(x.series_id)}>
                    {String(x.series_id)}: {x.enabled ? 'on' : 'OFF'}; {x.days_since === null || x.days_since === undefined ? 'no data loaded' : `${String(x.days_since)} day(s) since ${x.cadence === 'policy_change' ? 'last confirmed complete' : 'the last auction'}; stale after ${String(x.stale_after_days)}`}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
