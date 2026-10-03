'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PriceHistoryWaitingNotice, type PriceHistoryWaitState } from '@/components/reports/PriceHistoryWaitingNotice';

// Wraps the Performance figures (PO decision 2026-10-03): they are not drawn
// while the price history of the user's funds is still loading, so no partial /
// "not available" numbers appear for a fund that is about to have them. A user
// with no gaps never sees a waiting state (the children render as soon as the
// first, quick check answers). A fund whose history cannot be loaded is released
// by the server after a bounded window and named here in plain words; a failed
// check fails OPEN, so this can never trap anyone.
const POLL_MS = 6000;
const MAX_POLLS = 150;

type GateAnswer = PriceHistoryWaitState & { hold: boolean; disclosures: string[] };

export function PriceHistoryGate({ children }: { children: ReactNode }) {
  const [answer, setAnswer] = useState<GateAnswer | null>(null);
  const [failedOpen, setFailedOpen] = useState(false);
  const cancelled = useRef(false);

  const check = useCallback(async (): Promise<GateAnswer | null> => {
    try {
      const res = await fetch('/api/investment-intelligence/nav-history/gate');
      const json = await res.json();
      if (!res.ok || !json.data) return null;
      return json.data as GateAnswer;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    (async () => {
      let a = await check();
      if (cancelled.current) return;
      if (a === null) {
        setFailedOpen(true);
        return;
      }
      setAnswer(a);
      for (let i = 0; a.hold && i < MAX_POLLS && !cancelled.current; i++) {
        await fetch('/api/investment-intelligence/nav-history', { method: 'POST' }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelled.current) return;
        const next = await check();
        if (next === null) {
          setFailedOpen(true);
          return;
        }
        a = next;
        setAnswer(next);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [check]);

  if (failedOpen) return <>{children}</>;
  if (answer === null) return null; // the first check is quick; nothing partial is drawn meanwhile
  if (answer.hold) return <PriceHistoryWaitingNotice state={answer} subject="performance figures" />;
  return (
    <>
      {answer.disclosures.length > 0 && (
        <ul className="mb-4 space-y-0.5 rounded-lg border border-amber-200 bg-amber-50/40 p-3 text-xs text-ink">
          {answer.disclosures.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {children}
    </>
  );
}
