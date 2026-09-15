'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Pc5ResolutionItemView, Pc5ResolutionStatus } from '@/lib/pc5/types';

/**
 * PC5 (M4) — the resolution list (K.13, K.14, K.16).
 *
 * THE COUNT SHOWN HERE IS THE SERVER'S, NOT THIS COMPONENT'S. `stillBlockingCount`
 * comes straight from the API and is derived from the identical predicate
 * the acceptance gate enforces. This component never counts `items.length`
 * and calls it "blocking" — the default view is exception-only, so
 * `items.length` is a count of what is VISIBLE, which is a different number
 * and would drift the moment the filter changed. K.3's "no divergent
 * open-count" applies to the UI as much as to the database.
 *
 * STATUS LANGUAGE IS DELIBERATELY BLUNT (K.13). "Seen — still needs a
 * decision" rather than "Acknowledged", because the whole risk K.13
 * identifies is a user reading acknowledgement as completion. The word
 * "resolved" appears only for genuinely resolved items.
 */

const STATUS_LABEL: Record<Pc5ResolutionStatus, string> = {
  open: 'Needs a decision',
  acknowledged: 'Seen — still needs a decision',
  resolved: 'Resolved',
  dismissed: 'Hidden by you — still open',
  superseded: 'Replaced by a newer check',
};

const STATUS_TONE: Record<Pc5ResolutionStatus, string> = {
  open: 'bg-amber-50 text-amber-900 border-amber-200',
  acknowledged: 'bg-amber-50 text-amber-900 border-amber-200',
  resolved: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  dismissed: 'bg-slate-50 text-slate-700 border-slate-200',
  superseded: 'bg-slate-50 text-slate-700 border-slate-200',
};

interface ApiResponse {
  items: Pc5ResolutionItemView[];
  stillBlockingCount: number;
  hiddenNonMaterialCount: number;
  materialOnly: boolean;
  includeHistory: boolean;
}

export function ResolutionCentreClient({ runId }: { runId?: string }) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (runId) qs.set('run', runId);
      if (showAll) qs.set('material', 'all');
      if (showHistory) qs.set('history', '1');
      const res = await fetch(`/api/pc5/resolutions?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load your statement questions');
      setData(json.data as ApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your statement questions');
    } finally {
      setLoading(false);
    }
  }, [runId, showAll, showHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div>
      <div className="mb-5 rounded-md border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-ink">
          {data.stillBlockingCount === 0 ? (
            <>Nothing is waiting on you right now.</>
          ) : (
            <>
              <strong>
                {data.stillBlockingCount} {data.stillBlockingCount === 1 ? 'question' : 'questions'}
              </strong>{' '}
              must be answered before the affected statements can be imported. Holdings from those statements are not in your portfolio yet.
            </>
          )}
        </p>
        {data.hiddenNonMaterialCount > 0 && !showAll ? (
          <p className="mt-2 text-xs text-muted">
            {data.hiddenNonMaterialCount} lower-priority {data.hiddenNonMaterialCount === 1 ? 'item is' : 'items are'} hidden.{' '}
            <button type="button" className="underline" onClick={() => setShowAll(true)}>
              Show everything
            </button>
          </p>
        ) : null}
        {showAll ? (
          <p className="mt-2 text-xs text-muted">
            Showing everything.{' '}
            <button type="button" className="underline" onClick={() => setShowAll(false)}>
              Show only what needs a decision
            </button>
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">
          <button type="button" className="underline" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide resolved history' : 'Show resolved history'}
          </button>
        </p>
      </div>

      {data.items.length === 0 ? (
        <p className="text-sm text-muted">No statement questions to show.</p>
      ) : (
        <ul className="space-y-3">
          {data.items.map((item) => (
            <li key={item.id} className="rounded-md border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{item.humanQuestion}</p>
                  <p className="mt-1 text-sm text-muted">{item.explanation}</p>
                  {item.displayCandidate ? (
                    <p className="mt-2 text-xs text-muted">
                      On the statement: <span className="font-mono">{item.displayCandidate}</span>
                    </p>
                  ) : null}
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                {/* K.14: the link goes to the EXACT case, never to a
                    statement list the user would then have to search. */}
                <Link href={item.deepLinkHref} className="font-medium text-brand underline">
                  {item.permittedPc5Actions.includes('choose_value') ? 'Answer this' : 'Open this question'}
                </Link>
                {item.severity === 'blocking' ? <span className="text-xs text-muted">Blocks importing this statement</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
