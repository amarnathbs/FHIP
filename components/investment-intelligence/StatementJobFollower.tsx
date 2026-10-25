'use client';

import { useEffect, useRef, useState } from 'react';
import {
  describeJobEnd,
  driveStatementJob,
  jobProgressPercent,
  type AdvanceAnswer,
  type DriveOutcome,
  type StatementJobViewLike,
} from './statementJobDriver';

// Document2 (4) WP-J -- follows ONE statement job (processing, reprocessing after a replacement copy, Re-evaluate all) and shows it in plain
// words: queued / working with a progress bar / review ready / failed. It never shows a spinner without an honest status line, and it keeps
// going when the person leaves: the job runs on the server and a reload picks it up again (the screens list unfinished jobs on load).
//
// The document password, when there is one, is held in memory by the caller and handed to the server only with the slice that opens the
// file (`password_step`); the caller is told when that is over so it can discard it.

export interface StatementJobFollowerProps {
  jobId: string;
  /** In memory only; sent only while the job is still at the step that opens the file. */
  password?: string;
  /** Called with every state the server reports. */
  onUpdate?: (view: StatementJobViewLike) => void;
  /** Called once when the job ended (completed, needs a person, failed) or the screen gave up following. */
  onFinished?: (outcome: DriveOutcome, view: StatementJobViewLike | null) => void;
  compact?: boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function advanceOverHttp(jobId: string, password: string | undefined): Promise<AdvanceAnswer> {
  try {
    const res = await fetch(`/api/investment-intelligence/statement-jobs/${encodeURIComponent(jobId)}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

export function StatementJobStatusLine({ view, compact = false }: { view: StatementJobViewLike | null; compact?: boolean }) {
  if (!view) {
    return (
      <p role="status" aria-live="polite" className="text-xs text-gray-600" data-testid="statement-job-status">
        Queued. Starting in a moment. You can leave this page; it continues.
      </p>
    );
  }
  const pct = jobProgressPercent(view);
  const stalled = view.liveness === 'stalled' && (view.status === 'queued' || view.status === 'processing');
  return (
    <div role="status" aria-live="polite" className={compact ? 'w-full' : 'mt-1 w-full'} data-testid="statement-job-status">
      <p className="text-xs text-gray-700">{view.status === 'queued' && view.progress_done === 0 ? 'Queued. Starting in a moment. You can leave this page; it continues.' : view.message}</p>
      {(view.status === 'queued' || view.status === 'processing') && (
        <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded bg-gray-200" aria-hidden="true">
          <div className="h-full bg-gray-700 transition-all" style={{ width: `${pct ?? 5}%` }} />
        </div>
      )}
      {(view.status === 'queued' || view.status === 'processing') && pct !== null && <p className="mt-0.5 text-[11px] text-gray-500">{pct}% done</p>}
      {stalled && <p className="mt-0.5 text-[11px] text-gray-500">Waiting for the next step to start. It is saved; this page keeps asking.</p>}
    </div>
  );
}

export function StatementJobFollower({ jobId, password, onUpdate, onFinished, compact }: StatementJobFollowerProps) {
  const [view, setView] = useState<StatementJobViewLike | null>(null);
  const [ended, setEnded] = useState<{ ok: boolean; text: string } | null>(null);
  // The latest props, read inside the long-running loop without restarting it.
  const passwordRef = useRef(password);
  const onUpdateRef = useRef(onUpdate);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    passwordRef.current = password;
    onUpdateRef.current = onUpdate;
    onFinishedRef.current = onFinished;
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await driveStatementJob({
        jobId,
        advance: (id, o) => advanceOverHttp(id, o.sendPassword ? passwordRef.current : undefined),
        wait,
        isCancelled: () => cancelled,
        onUpdate: (v) => {
          if (cancelled) return;
          setView(v);
          onUpdateRef.current?.(v);
        },
      });
      if (cancelled) return;
      setEnded(describeJobEnd(result.outcome, result.view));
      onFinishedRef.current?.(result.outcome, result.view);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (ended) {
    return (
      <p role="status" aria-live="polite" className={`w-full text-xs ${ended.ok ? 'text-green-700' : 'text-red-700'}`} data-testid="statement-job-ended">
        {ended.text}
      </p>
    );
  }
  return <StatementJobStatusLine view={view} compact={compact} />;
}
