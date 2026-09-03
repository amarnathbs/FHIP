'use client';

// R1.6 Context Mapping admin — spec §57-58/§78. Left column: pick a
// registered context key (spec §58: only registered keys are selectable at
// all — there is no free-text key entry anywhere in this UI). Right column:
// manage that key's mapped Resources (add/remove/reorder/activate).
//
// Admin A0.2 Wave 5 — this screen was the weakest result-state surface in
// Admin, and every fix below closes a defect this Wave's inventory found:
//
//   §9  `remove`, `toggleActive` and `move` never inspected the response at
//       all (`await fetch(...)` then reload). A 403 or 500 was completely
//       silent: the row simply reappeared after the reload with no
//       explanation, which reads as "the app is broken", not "you are not
//       allowed to do that". All three now check the outcome and report it.
//   §9  `move` fired one PATCH per row via Promise.all, never checked any of
//       them, and set the new order optimistically without ever reverting.
//       A partial failure left the database in one order and the screen
//       showing another — the exact bug the sibling Related Content screen
//       documents having already fixed. Reordering now applies the writes,
//       verifies every one, and reloads the server's own committed order
//       rather than trusting the optimistic state.
//   §9  No mutation produced any success confirmation.
//   §10 `Remove`, `Deactivate` and `Activate` were single unconfirmed
//       clicks, despite deactivating a mapping stopping a live in-product
//       link from rendering.
//   §11 `Deactivate`/`Activate`/`Remove` had no accessible name naming the
//       row, while the arrows in the same row did. Touch targets were about
//       24px. There was no focus-visible styling and no live region.
//   §18 Whether a mapping was active could only be inferred from the
//       inverse of a button label — there was no status shown at all.
//   §19 The add path forwarded the raw server message.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { FHIP_CONTEXTS } from '@/lib/resources/context/registry';
import { formatStatusForPicker, formatContentTypeForPicker, type RelatableSearchResult } from '@/lib/resources/discovery/relatedAdmin';

interface ContextMappingRow {
  id: string;
  context_key: string;
  module: string;
  label: string;
  metric_or_feature: string | null;
  sort_order: number;
  is_active: boolean;
  resource: { id: string; title: string; slug: string | null; content_type: string; status: string } | null;
}

function PostPicker({ onPick, excludeId }: { onPick: (post: RelatableSearchResult) => void; excludeId?: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RelatableSearchResult[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Every branch schedules its state update inside the timeout (even the
    // empty-query "clear" case) rather than calling setState synchronously
    // in the effect body — avoids cascading-render re-entrancy.
    debounceRef.current = setTimeout(async () => {
      if (!q.trim()) {
        setResults([]);
        setSearchState('idle');
        return;
      }
      setSearchState('searching');
      try {
        const qp = new URLSearchParams({ q });
        if (excludeId) qp.set('exclude', excludeId);
        const res = await fetch(`/api/admin/resources/related/search-posts?${qp.toString()}`);
        const json = await readJsonSafely(res);
        if (!res.ok) {
          // §9 — a failed search previously left the last results on screen
          // with no signal, so the operator could act on stale matches.
          setResults([]);
          setSearchState('failed');
          return;
        }
        setResults((json?.data as RelatableSearchResult[]) ?? []);
        setSearchState('done');
      } catch {
        setResults([]);
        setSearchState('failed');
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, excludeId]);

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="context-post-picker">
        Map a Resource to this context
      </label>
      <input id="context-post-picker" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title…" className="w-full rounded-compact border border-line px-3 py-2 text-sm" />
      <p role="status" aria-live="polite" className="mt-1 text-xs text-muted">
        {searchState === 'searching' && 'Searching…'}
        {searchState === 'failed' && 'That search could not be run. Try again.'}
        {searchState === 'done' && results.length === 0 && 'No resources match that search.'}
        {searchState === 'done' && results.length > 0 && `${results.length} ${results.length === 1 ? 'match' : 'matches'}.`}
      </p>
      {results.length > 0 && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-compact border border-line p-2">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setQ('');
                  setResults([]);
                  setSearchState('idle');
                }}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm outline-offset-2 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-trust"
              >
                <span className="truncate text-ink">{r.title}</span>
                <span className="shrink-0 text-xs text-muted">
                  {formatContentTypeForPicker(r.content_type)} · {formatStatusForPicker(r.status)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PendingMapping =
  | { kind: 'remove'; row: ContextMappingRow }
  | { kind: 'deactivate'; row: ContextMappingRow }
  | { kind: 'activate'; row: ContextMappingRow };

export function ContextMappingManager({ canManage }: { canManage: boolean }) {
  const [contextKey, setContextKey] = useState(FHIP_CONTEXTS[0]?.key ?? '');
  const [mappings, setMappings] = useState<ContextMappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMapping | null>(null);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();

  const activeDef = FHIP_CONTEXTS.find((c) => c.key === contextKey);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/admin/resources/context?contextKey=${encodeURIComponent(key)}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, 'the mappings for this context'));
        setMappings([]);
        return;
      }
      const data = json?.data as { items?: ContextMappingRow[] } | undefined;
      setMappings(data?.items ?? []);
    } catch (e) {
      setFailure(failureFromThrown(e, 'the mappings for this context'));
      setMappings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick (matches the debounced-load convention used elsewhere
    // in this admin shell) rather than invoking `load` synchronously in the
    // effect body, which begins executing its own setState calls before the
    // first `await` — the react-hooks/set-state-in-effect rule flags that
    // re-entrancy risk even though `load` itself is declared async.
    const timer = setTimeout(() => {
      if (contextKey) void load(contextKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [contextKey, load]);

  const titleOf = (m: ContextMappingRow) => m.resource?.title ?? 'this deleted content';

  async function addMapping(post: RelatableSearchResult) {
    if (busy) return;
    setBusy(true);
    clearOutcome();
    try {
      const res = await fetch('/api/admin/resources/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context_key: contextKey, resource_post_id: post.id, sort_order: mappings.length, is_active: true }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'add this mapping'));
        return;
      }
      reportSuccess(`"${post.title}" is now mapped to this context and is active.`);
      await load(contextKey);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function applyPending(action: PendingMapping) {
    setBusy(true);
    clearOutcome();
    const title = titleOf(action.row);
    try {
      const res =
        action.kind === 'remove'
          ? await fetch(`/api/admin/resources/context/${action.row.id}`, { method: 'DELETE' })
          : await fetch(`/api/admin/resources/context/${action.row.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_active: action.kind === 'activate' }),
            });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(
          actionFailureMessage(
            res.status,
            json,
            action.kind === 'remove' ? 'remove this mapping' : action.kind === 'activate' ? 'activate this mapping' : 'deactivate this mapping'
          )
        );
        await load(contextKey);
        return;
      }
      reportSuccess(
        action.kind === 'remove'
          ? `"${title}" is no longer mapped to this context.`
          : action.kind === 'activate'
            ? `"${title}" is active again for this context.`
            : `"${title}" is now inactive. It will not be used for this context until it is activated again.`
      );
      await load(contextKey);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    if (busy) return;
    const target = index + direction;
    if (target < 0 || target >= mappings.length) return;

    const reordered = [...mappings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    setBusy(true);
    clearOutcome();
    // Optimistic, but only until the server has confirmed — the reload below
    // always replaces this with the committed order, and a failure reloads
    // rather than leaving the optimistic order standing.
    setMappings(reordered);
    try {
      const responses = await Promise.all(
        reordered.map((m, i) =>
          fetch(`/api/admin/resources/context/${m.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sort_order: i }),
          })
        )
      );
      const firstFailure = responses.find((r) => !r.ok);
      if (firstFailure) {
        const json = await readJsonSafely(firstFailure);
        reportFailure(
          `${actionFailureMessage(firstFailure.status, json, 'change the order of these mappings')} The list below has been reloaded to show the order that is actually stored.`
        );
      } else {
        reportSuccess('New order saved.');
      }
    } catch {
      reportFailure('Could not reach the server. The list below has been reloaded to show the order that is actually stored.');
    } finally {
      setBusy(false);
      // Always reconcile against the server rather than trusting the
      // optimistic order, including on the success path.
      await load(contextKey);
    }
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={!!pending}
        title={
          pending?.kind === 'remove'
            ? 'Remove this mapping?'
            : pending?.kind === 'deactivate'
              ? 'Deactivate this mapping?'
              : 'Activate this mapping?'
        }
        message={
          pending
            ? pending.kind === 'remove'
              ? `"${titleOf(pending.row)}" will no longer be mapped to this context. If it was the lowest-ordered active mapping, the "What does this mean?" link here will resolve to the next active one, or render nothing if there is none. You can map it again afterwards.`
              : pending.kind === 'deactivate'
                ? `"${titleOf(pending.row)}" will stop being used for this context immediately, without being deleted. If it was the lowest-ordered active mapping, readers will get the next active one instead, or nothing if there is none.`
                : `"${titleOf(pending.row)}" will be used for this context again if it is the lowest-ordered active mapping.`
            : ''
        }
        confirmLabel={pending?.kind === 'remove' ? 'Remove Mapping' : pending?.kind === 'deactivate' ? 'Deactivate' : 'Activate'}
        cancelLabel="Cancel"
        destructive={pending?.kind !== 'activate'}
        onConfirm={() => {
          const action = pending;
          setPending(null);
          if (action) void applyPending(action);
        }}
        onCancel={() => setPending(null)}
      />

      <div>
        <h1 className="text-2xl font-semibold text-ink">Context Mapping</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Decide which resource the &ldquo;What does this mean?&rdquo; link opens from each place in FHIP. The lowest-ordered
          active mapping is the one readers get.
        </p>
      </div>

      <AdminTaskHelp taskId="ADM-17" />

      <div className="max-w-md">
        <label htmlFor="context-key-select" className="mb-1 block text-sm font-medium text-ink">
          Context Key
        </label>
        <select id="context-key-select" value={contextKey} onChange={(e) => setContextKey(e.target.value)} className="min-h-11 w-full rounded-compact border border-line bg-white px-3 py-2 text-sm">
          {FHIP_CONTEXTS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.module} — {c.label} ({c.key})
            </option>
          ))}
        </select>
        {activeDef && (
          <p className="mt-1 text-xs text-muted">
            Opens: <code>{activeDef.route}</code>
          </p>
        )}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <AdminActionStatus outcome={outcome} className="mb-3" />

        {failure && (
          <div role={failure.retryable ? 'alert' : 'status'} className="mb-3 rounded-compact border border-line p-3">
            <p className={`text-sm font-semibold ${failure.retryable ? 'text-risk' : 'text-ink'}`}>{failure.title}</p>
            <p className="mt-1 text-sm text-muted">{failure.message}</p>
            {failure.retryable && (
              <button type="button" onClick={() => load(contextKey)} className="mt-2 min-h-11 text-sm font-semibold text-trust hover:underline">
                Retry
              </button>
            )}
          </div>
        )}

        {loading ? (
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Loading mappings…
          </p>
        ) : mappings.length === 0 ? (
          !failure && (
            <p className="text-sm text-muted">
              No Resource is mapped to this context yet. The &ldquo;What does this mean?&rdquo; link will render nothing until one is added and active.
            </p>
          )
        ) : (
          <ol className="space-y-2">
            {mappings.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 rounded-compact border border-line p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{m.resource?.title ?? '(deleted content)'}</p>
                  <p className="text-xs text-muted">
                    {/* §18 — an explicit Active/Inactive state. Previously the
                        only signal was the inverse of a button label. */}
                    <span className={`mr-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${m.is_active ? 'bg-positive/10 text-positive' : 'bg-gray-100 text-gray-600'}`}>
                      {m.is_active ? 'Active' : 'Inactive'}
                    </span>
                    {m.resource && (
                      <>
                        {formatContentTypeForPicker(m.resource.content_type)} · {formatStatusForPicker(m.resource.status)}
                        {m.resource.status !== 'published' && m.resource.status !== 'review_due' && <span className="ml-1 font-semibold text-attention">(not currently public — link will not render)</span>}
                      </>
                    )}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0 || busy}
                      aria-label={`Move ${m.resource?.title ?? 'item'} up`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-line px-2 py-1 text-xs outline-offset-2 focus-visible:outline-2 focus-visible:outline-trust disabled:opacity-30"
                    >
                      <span aria-hidden="true">↑</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === mappings.length - 1 || busy}
                      aria-label={`Move ${m.resource?.title ?? 'item'} down`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-line px-2 py-1 text-xs outline-offset-2 focus-visible:outline-2 focus-visible:outline-trust disabled:opacity-30"
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPending({ kind: m.is_active ? 'deactivate' : 'activate', row: m })}
                      disabled={busy}
                      aria-label={`${m.is_active ? 'Deactivate' : 'Activate'} the mapping to ${m.resource?.title ?? 'deleted content'}`}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-line px-2 py-1 text-xs font-semibold outline-offset-2 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-trust disabled:opacity-30"
                    >
                      {m.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPending({ kind: 'remove', row: m })}
                      disabled={busy}
                      aria-label={`Remove the mapping to ${m.resource?.title ?? 'deleted content'}`}
                      className="inline-flex min-h-11 items-center justify-center rounded border border-line px-2 py-1 text-xs font-semibold text-risk outline-offset-2 hover:bg-risk/5 focus-visible:outline-2 focus-visible:outline-risk disabled:opacity-30"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {canManage && (
          <div className="mt-4 border-t border-line pt-4">
            <PostPicker onPick={addMapping} />
          </div>
        )}
      </div>
    </div>
  );
}
