'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDate } from './dateDisplay';

// Where the user sees their funds' price history being filled in (PO decision
// 2026-10-03). Plain words, never ids, dates day-first:
//   "Fetching price history for 3 of 5 funds"
//   "History loaded"
//   "Waiting for data for <fund>. We will keep trying."
//
// It renders NOTHING when there is nothing to say (no funds, or every fund's
// history is loaded), so it is safe on any page, and it never blocks anything.
//
// Fetching happens on the server, in small time-boxed slices: while at least one
// fund is still being fetched this panel asks for the next slice (POST), a few
// times, a few seconds apart, then stops; the scheduled job is the fallback and
// "Check now" asks again on demand. A fund's returns are not computed from
// missing prices: until its history is in, its figures say so.

export interface NavHistorySchemeView {
  instrumentId: string;
  schemeName: string;
  state: 'loaded' | 'pending' | 'loading' | 'waiting';
  loadingFrom: string | null;
}

export interface NavHistorySummaryView {
  total: number;
  loaded: number;
  fetching: number;
  waiting: number;
  headline: string | null;
  waitingLines: string[];
}

const MAX_AUTO_SLICES = 8;
const SLICE_DELAY_MS = 4000;

/** Presentational, so the exact words the user sees can be tested. */
export function NavHistoryStatusView({
  summary,
  schemes,
  busy,
  dateCurrency,
  onCheckNow,
}: {
  summary: NavHistorySummaryView;
  schemes: NavHistorySchemeView[];
  busy: boolean;
  dateCurrency: 'AUD' | 'INR';
  onCheckNow: () => void;
}) {
  if (summary.total === 0 || summary.headline === null) return null;
  const allLoaded = summary.loaded === summary.total;
  const fetchingSchemes = schemes.filter((s) => s.state === 'pending' || s.state === 'loading');
  return (
    <section
      aria-labelledby="nav-history-heading"
      aria-live="polite"
      className={`mb-6 rounded-lg border p-3 text-sm ${allLoaded ? 'border-green-200 bg-green-50/40' : 'border-amber-200 bg-amber-50/40'}`}
    >
      <h2 id="nav-history-heading" className="font-semibold text-ink">
        {summary.headline}
      </h2>
      {!allLoaded && (
        <p className="mt-1 text-muted">
          Returns for a fund appear once its price history is in. Until then that fund’s figures say its history is being loaded. Nothing else is held up.
        </p>
      )}
      {fetchingSchemes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {fetchingSchemes.map((s) => (
            <li key={s.instrumentId}>
              {s.schemeName}
              {s.loadingFrom ? `: loading from ${fmtDate(s.loadingFrom, dateCurrency)}` : ''}
            </li>
          ))}
        </ul>
      )}
      {summary.waitingLines.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-ink">
          {summary.waitingLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {!allLoaded && (
        <button type="button" onClick={onCheckNow} disabled={busy} className="mt-2 min-h-9 rounded border border-line px-3 py-1.5 text-sm text-primary disabled:opacity-50">
          {busy ? 'Checking…' : 'Check now'}
        </button>
      )}
    </section>
  );
}

export function NavHistoryStatusPanel({ dateCurrency = 'INR' }: { dateCurrency?: 'AUD' | 'INR' }) {
  const [summary, setSummary] = useState<NavHistorySummaryView | null>(null);
  const [schemes, setSchemes] = useState<NavHistorySchemeView[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const apply = useCallback((data: { summary?: NavHistorySummaryView; schemes?: NavHistorySchemeView[] } | undefined) => {
    if (!data?.summary) return;
    setSummary(data.summary);
    setSchemes(data.schemes ?? []);
  }, []);

  // Slices of server work (POST), a few seconds apart, while some fund is still being fetched and we have not used our few automatic slices.
  const runSlices = useCallback(async () => {
    setBusy(true);
    try {
      for (let i = 0; i < MAX_AUTO_SLICES && !cancelled.current; i++) {
        const res = await fetch('/api/investment-intelligence/nav-history', { method: 'POST' });
        const json = await res.json();
        if (!res.ok) break;
        apply(json.data);
        const more = (json.data?.summary?.fetching ?? 0) > 0 && !json.data?.rateLimited;
        if (!more) break;
        await new Promise((resolve) => setTimeout(resolve, SLICE_DELAY_MS));
      }
    } catch {
      /* silent by design: the scheduled job is the fallback */
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    cancelled.current = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/nav-history');
        const json = await res.json();
        if (!res.ok || cancelled.current) return;
        apply(json.data);
        if ((json.data?.summary?.fetching ?? 0) > 0) await runSlices();
      } catch {
        /* silent by design */
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [apply, runSlices]);

  if (!summary) return null;
  return (
    <NavHistoryStatusView
      summary={summary}
      schemes={schemes}
      busy={busy}
      dateCurrency={dateCurrency}
      onCheckNow={() => void runSlices()}
    />
  );
}
