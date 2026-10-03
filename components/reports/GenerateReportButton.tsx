'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PriceHistoryWaitingNotice, type PriceHistoryWaitState } from './PriceHistoryWaitingNotice';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// PO 2026-10-03: the report is generated ONLY after the price history of the
// user's funds is in. While it is not, the server answers 202 (nothing stored)
// and this button shows the waiting state, drives the fetch in small slices,
// and asks again every few seconds until the report is built. The server also
// releases it, with the unloadable fund named, after a bounded retry window, so
// this loop always ends.
const POLL_MS = 6000;
const MAX_POLLS = 150; // ~15 minutes: comfortably beyond the server's retry window

export function GenerateReportButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<PriceHistoryWaitState | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const attempt = useCallback(async (): Promise<'done' | 'waiting' | 'error'> => {
    const res = await fetch('/api/reports/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportType: 'monthly_financial_health', reportMonth: monthStart() }),
    });
    const json = await res.json();
    if (res.status === 202 && json.data?.waiting) {
      setWaiting(json.data as PriceHistoryWaitState);
      return 'waiting';
    }
    if (!res.ok) throw new Error(json.error ?? 'Could not generate report');
    setWaiting(null);
    if (json.data?.report?.id) router.push(`/reports/${json.data.report.id}`);
    router.refresh();
    return 'done';
  }, [router]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      let outcome = await attempt();
      for (let i = 0; outcome === 'waiting' && i < MAX_POLLS && !stopped.current; i++) {
        // Drive the fetch (a small, time-boxed slice for this user's funds), then ask again.
        await fetch('/api/investment-intelligence/nav-history', { method: 'POST' }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (stopped.current) return;
        outcome = await attempt();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setWaiting(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? (waiting ? 'Waiting for price history...' : 'Generating...') : 'Generate report'}
      </button>
      {waiting && (
        <div className="mt-3">
          <PriceHistoryWaitingNotice state={waiting} />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
    </div>
  );
}
