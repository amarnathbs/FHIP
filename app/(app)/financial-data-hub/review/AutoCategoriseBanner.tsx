'use client';

import { useEffect, useRef, useState } from 'react';
import { autoBannerLines, type AutoRunSummary } from '@/lib/financial-data-hub/domain/premiumAutoCategorise';
// Type-only (erased at build): the screen reads exactly the shape the routes return.
import type { AutoCategoriseResult, AutoCategoriseState } from '@/lib/financial-data-hub/services/premiumAutoCategoriseService';

/**
 * Premium automatic categorisation (PO 05-11-2026) -- the part of the review screen that starts it, says what it did, and offers Undo.
 *
 * Kept as its own component on purpose: it owns its own state, so it cannot disturb the review screen's long list of hooks. It shows nothing at
 * all unless the server says the feature is on (`enabled`), so a Free person, or an environment with the flag off, sees exactly the screen they
 * had before. On first view of a statement that is eligible it starts the run ONCE (a ref guards a double mount), then asks the screen to reload.
 */

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? 'Something went wrong. Please try again.');
  return json.data as T;
}
async function apiPost<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? 'Something went wrong. Please try again.');
  return json.data as T;
}

export function AutoCategoriseBanner({ statementId, onChanged }: { statementId: string; onChanged: () => void | Promise<void> }) {
  const base = `/api/financial-data-hub/documents/${encodeURIComponent(statementId)}/category-review/auto-categorise`;
  const [summary, setSummary] = useState<AutoRunSummary | null>(null);
  const [phase, setPhase] = useState<'idle' | 'running' | 'undoing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // Separate from `started` so React's development double-mount (mount, unmount, mount) neither starts the run twice nor drops its result.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const state = await apiGet<AutoCategoriseState>(base);
        if (!alive.current || !state.enabled) return;
        if (state.summary) setSummary(state.summary);
        if (!state.eligible) return;
        setPhase('running');
        const result = await apiPost<AutoCategoriseResult>(base);
        if (!alive.current) return;
        if (result.summary) setSummary(result.summary);
        await onChanged();
      } catch {
        // The review works exactly as before; nothing is hidden or lost. The person is told, once.
        if (alive.current) setError('We could not categorise this statement automatically. You can review and approve it below as usual.');
      } finally {
        if (alive.current) setPhase('idle');
      }
    })();
    // A one-time start per mount: `started` guards a repeat, and `base`/`onChanged` are stable for the life of this statement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function undo() {
    setPhase('undoing');
    setError(null);
    try {
      await apiPost<{ reverted: number | null }>(`${base}/undo`);
      setSummary(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'We could not undo this. Please try again.');
    } finally {
      setPhase('idle');
    }
  }

  if (phase === 'running') {
    return (
      <p role="status" aria-live="polite" className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink">
        Categorising and counting your statement… This can take a minute.
      </p>
    );
  }
  if (error && !summary) {
    return <p role="alert" className="rounded-compact bg-risk/10 px-3 py-2 text-sm text-risk">{error}</p>;
  }
  if (!summary || summary.approved_lines === 0) return null;

  return (
    <section aria-labelledby="auto-heading" className="rounded-compact border border-trust/40 bg-trust/5 p-4">
      <h2 id="auto-heading" className="text-base font-semibold text-ink">Categorised automatically</h2>
      <div className="mt-1 space-y-1 text-sm text-ink">
        {autoBannerLines(summary).map((line) => <p key={line}>{line}</p>)}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-risk">{error}</p>}
      <button
        type="button"
        disabled={phase !== 'idle'}
        onClick={() => { void undo(); }}
        className="mt-3 rounded-compact border border-trust px-3 py-1.5 text-sm font-semibold text-trust disabled:opacity-50"
      >
        {phase === 'undoing' ? 'Undoing…' : 'Undo, so I can change it'}
      </button>
    </section>
  );
}
