'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PriceHistoryWaitingNotice, type PriceHistoryWaitState } from './PriceHistoryWaitingNotice';
import { runGenerate, type ApiFailure } from '@/lib/reports/apiClient';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// PO 2026-10-03: the report is generated ONLY after the price history of the
// user's funds is in. While it is not, the server answers 202 (nothing stored)
// and this button shows the waiting state, drives the fetch in small slices,
// and asks again every few seconds until the report is built. The server also
// releases it, with the unloadable fund named, after a bounded retry window, so
// this loop always ends.
//
// 16-10-2026: the answer is never read with response.json(). The body is read
// as text and parsed defensively (lib/reports/apiClient.ts), so an empty body
// (the platform cutting a long request), an HTML gateway page or a typed error
// each become a plain message with a retry, never "Unexpected end of JSON
// input". A report that is still being prepared (HTTP 202 "preparing") is asked
// for again with a growing pause; asking again is idempotent on the server.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function GenerateReportButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [waiting, setWaiting] = useState<PriceHistoryWaitState | null>(null);
  const [status, setStatus] = useState('');
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const generate = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setStatus('Generating your report.');
    try {
      const outcome = await runGenerate({
        fetchFn: (input, init) => fetch(input, init),
        body: { reportType: 'monthly_financial_health', reportMonth: monthStart() },
        sleep,
        isStopped: () => stopped.current,
        // Drive the fetch (a small, time-boxed slice for this user's funds), then ask again.
        driveHistory: async () => {
          await fetch('/api/investment-intelligence/nav-history', { method: 'POST' }).catch(() => undefined);
        },
        onStatus: (s) => {
          if (stopped.current) return;
          setWaiting(s.waiting as PriceHistoryWaitState | null);
          setStatus(s.announcement);
        },
      });
      if (outcome.kind === 'stopped') return;
      setWaiting(null);
      if (outcome.kind === 'error') {
        setFailure(outcome.failure);
        setStatus('');
        return;
      }
      setStatus('Your report is ready. Opening it now.');
      if (outcome.reportId) router.push(`/reports/${outcome.reportId}`);
      router.refresh();
    } catch (e) {
      // Defensive: runGenerate does not throw, but nothing unexpected may leave the button stuck or show a raw message.
      console.error('[reports] generate button failed unexpectedly', e);
      setFailure({ message: 'Something went wrong while generating your report. Please try again.', code: null, correlationId: null, retryable: true, status: 0 });
      setWaiting(null);
      setStatus('');
    } finally {
      setLoading(false);
    }
  }, [router]);

  return (
    <div>
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
        {loading ? (waiting ? 'Waiting for price history...' : 'Generating...') : 'Generate report'}
      </button>
      {/* Polite status updates for screen readers: the preparing / retrying / ready messages. */}
      <p role="status" aria-live="polite" className={status ? 'mt-2 text-sm text-muted' : 'sr-only'}>
        {status}
      </p>
      {waiting && (
        <div className="mt-3">
          <PriceHistoryWaitingNotice state={waiting} />
        </div>
      )}
      {failure && (
        <div role="alert" className="mt-2 text-sm text-risk">
          <p>{failure.message}</p>
          {failure.correlationId && <p className="mt-1 text-xs text-muted">Reference: {failure.correlationId}</p>}
          {failure.retryable && (
            <button onClick={generate} disabled={loading} className="mt-2 rounded border border-trust px-3 py-1 text-sm text-trust disabled:opacity-60">
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
