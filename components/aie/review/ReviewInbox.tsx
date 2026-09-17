'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ResourceEmptyState, ResourceErrorState, ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';
import { ariaLabelForUserState } from '@/lib/aie/review/ariaLabels';

interface RunSummary {
  runId: string;
  intakeId: string;
  userState: string;
  moduleLabel: string;
  openBlockingItemCount: number;
  displayFilename: string | null;
  createdAt: string;
}

const STATE_COPY: Record<string, { label: string; tone: 'neutral' | 'attention' | 'good' | 'bad' }> = {
  processing: { label: 'Processing', tone: 'neutral' },
  ready_to_accept: { label: 'Ready to accept', tone: 'good' },
  needs_your_review: { label: 'Needs your review', tone: 'attention' },
  unable_to_process_safely: { label: 'Unable to process', tone: 'bad' },
  accepted_importing: { label: 'Importing', tone: 'neutral' },
  import_failed: { label: 'Import failed', tone: 'bad' },
  completed: { label: 'Completed', tone: 'good' },
};

// A11Y-07: colour is never the ONLY signal — every chip's visible TEXT
// comes from STATE_COPY above (not just a background colour class), and
// `ariaLabelForUserState` supplies the accessible name explicitly so a
// screen reader never has to infer status from colour or icon alone.
function StateChip({ state }: { state: string }) {
  const copy = STATE_COPY[state] ?? { label: state, tone: 'neutral' as const };
  const toneClasses: Record<string, string> = {
    neutral: 'bg-gray-100 text-ink',
    attention: 'bg-amber-100 text-amber-800',
    good: 'bg-green-100 text-green-800',
    bad: 'bg-risk/10 text-risk',
  };
  return (
    <span aria-label={ariaLabelForUserState(state)} className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${toneClasses[copy.tone]}`}>
      {copy.label}
    </span>
  );
}

async function fetchInbox(): Promise<{ runs: RunSummary[] } | { error: string }> {
  try {
    const res = await fetch('/api/aie/review/inbox');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.message ?? body?.error ?? 'Could not load your documents.' };
    return { runs: body.data.runs };
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' };
  }
}

export function ReviewInbox() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);

  // Mount/retry-triggered load, following the Financial Data Hub review
  // workspace's own established cancelled-flag IIFE pattern (a
  // `retryToken` bump — not a directly-invoked callback — re-runs this
  // effect, so the Retry button never calls a state-setting function
  // directly from outside an effect either).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const result = await fetchInbox();
      if (cancelled) return;
      if ('error' in result) setError(result.error);
      else setRuns(result.runs);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  if (loading) return <ResourceLoadingSkeleton label="Loading your documents" />;
  if (error) return <ResourceErrorState message={error} title="We couldn't load your documents." onRetry={() => setRetryToken((t) => t + 1)} />;
  if (!runs || runs.length === 0) {
    return <ResourceEmptyState title="No documents yet" message="Uploaded documents that need a quick confirmation or your review will appear here." />;
  }

  return (
    <ul className="space-y-2" aria-label="Your documents">
      {runs.map((run) => (
        <li key={run.runId}>
          <Link
            href={`/aie-review/${run.runId}`}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-white px-4 py-3 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-trust"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-ink">{run.displayFilename ?? `${run.moduleLabel} document`}</span>
              <span className="text-xs text-muted">{run.moduleLabel}</span>
            </span>
            <span className="flex items-center gap-2">
              {run.openBlockingItemCount > 0 && (
                <span className="text-xs text-muted">
                  {run.openBlockingItemCount} {run.openBlockingItemCount === 1 ? 'issue' : 'issues'}
                </span>
              )}
              <StateChip state={run.userState} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
