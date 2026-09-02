'use client';

// R1.6 Related Content admin — spec §39/§77. Standalone screen (see
// lib/resources/discovery/relatedAdmin.ts's header for why this is not a
// panel bolted onto the certified R1.3 editor). Step 1: pick a source
// Resource (title search, staff sees every status). Step 2: manage that
// source's manual relationships — add (search + relationship type), remove,
// reorder with plain Up/Down buttons (spec §112: "Do not require
// drag-and-drop").

// Admin A0.2 Wave 5 fixed four defects on this screen. The Wave 2 reorder
// lifecycle below is deliberately untouched — it is already the strongest
// mutation path in Admin and this Wave found nothing wrong with it:
//   §9/§10 `Remove` deleted a curated relationship on a single unconfirmed
//          click, and — worse — never inspected the response (`if (res.ok)`
//          with no else), so a failed delete silently appeared to succeed
//          until the next reload.
//   §9     Adding a relationship gave no confirmation at all.
//   §9     The picker swallowed search failures, leaving stale results on
//          screen with no signal, and had no zero-results state.
//   §19    The purpose sentence cited "spec §29-30" to operators.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { actionFailureMessage, readJsonSafely } from '@/lib/resources/admin/resultState';
import { RELATIONSHIP_TYPES, RELATIONSHIP_TYPE_LABELS, formatStatusForPicker, formatContentTypeForPicker, type RelationshipType, type RelatedContentAdminRow, type RelatableSearchResult } from '@/lib/resources/discovery/relatedAdmin';

function PostPicker({ onPick, excludeId, label }: { onPick: (post: RelatableSearchResult) => void; excludeId?: string; label: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RelatableSearchResult[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Every branch schedules its state update inside the timeout (even the
    // empty-query "clear" case) rather than calling setState synchronously
    // in the effect body.
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
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor={`picker-${label}`}>
        {label}
      </label>
      <input id={`picker-${label}`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title…" className="w-full rounded-compact border border-line px-3 py-2 text-sm" />
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

export function RelatedContentManager({ canManage }: { canManage: boolean }) {
  const [source, setSource] = useState<RelatableSearchResult | null>(null);
  const [relations, setRelations] = useState<RelatedContentAdminRow[]>([]);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('related');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Wave 2 (Scope A): explicit reorder lifecycle so the administrator can
  // always tell whether the order on screen is committed.
  const [reorderState, setReorderState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'failed'>('idle');
  const [reorderMessage, setReorderMessage] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<RelatedContentAdminRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();

  const loadRelations = useCallback(async (postId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/resources/related?postId=${postId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setRelations(json.data.items);
    } catch {
      setError('Could not load related content for this Resource.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      // Changing the source Resource clears any stale reorder feedback, so a
      // "Order saved." from a previous Resource can never appear beside a
      // different Resource's list.
      setReorderState('idle');
      setReorderMessage(null);
      if (source) void loadRelations(source.id);
    }, 0);
    return () => clearTimeout(timer);
  }, [source, loadRelations]);

  async function addRelation(target: RelatableSearchResult) {
    if (!source) return;
    setError(null);
    clearOutcome();
    try {
      const res = await fetch('/api/admin/resources/related', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_post_id: source.id, related_post_id: target.id, relationship_type: relationshipType }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'add this relationship'));
        return;
      }
      reportSuccess(`"${target.title}" added as ${RELATIONSHIP_TYPE_LABELS[relationshipType]}, at the end of the list.`);
      await loadRelations(source.id);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    }
  }

  async function confirmRemoveRelation() {
    const row = pendingRemove;
    if (!source || !row) return;
    setPendingRemove(null);
    setRemoving(true);
    clearOutcome();
    const title = row.related?.title ?? 'that relationship';
    try {
      const res = await fetch(`/api/admin/resources/related/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await readJsonSafely(res);
        // Wave 4 made this route return a real 404 when the relationship has
        // already gone. That is the desired end state, not a failure the
        // operator must act on — say so plainly instead of reporting an error.
        if (res.status === 404) {
          reportSuccess(`"${title}" was already removed. The list below has been refreshed.`);
        } else {
          reportFailure(actionFailureMessage(res.status, json, 'remove this relationship'));
        }
        await loadRelations(source.id);
        return;
      }
      reportSuccess(`"${title}" is no longer shown as related content. You can add it again at any time.`);
      await loadRelations(source.id);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setRemoving(false);
    }
  }

  // Admin A0.2 Wave 2 (Scope A). This used to reorder optimistically and
  // fire the PATCH without ever reading the response, so a rejected or
  // partially applied reorder left the screen showing an ordering that was
  // never committed. It now: blocks repeated submission while saving, shows
  // saving/saved/conflict/failure states, and on ANY failure reloads the
  // canonical ordering from the server rather than keeping the optimistic
  // one.
  async function move(index: number, direction: -1 | 1) {
    if (!source || reorderState === 'saving') return;
    const target = index + direction;
    if (target < 0 || target >= relations.length) return;

    const previous = relations;
    const next = [...relations];
    [next[index], next[target]] = [next[target], next[index]];
    setRelations(next);
    setReorderState('saving');
    setReorderMessage(null);

    try {
      const res = await fetch('/api/admin/resources/related/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_post_id: source.id, ordered_ids: next.map((r) => r.id) }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        // Re-sort the rows into the order the server actually COMMITTED and
        // returned, so the screen can never show an ordering the database
        // did not accept — even if it happens to match what we just sent.
        const committed: { id: string; sort_order: number }[] = json?.data?.ordered ?? [];
        if (committed.length === next.length) {
          const rank = new Map(committed.map((c) => [c.id, c.sort_order]));
          setRelations([...next].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)));
        }
        setReorderState('saved');
        setReorderMessage('Order saved.');
        return;
      }

      // Failed: never leave the uncommitted ordering on screen.
      setRelations(previous);
      if (res.status === 409) {
        setReorderState('conflict');
        setReorderMessage(json?.error ?? 'The related items for this Resource have changed since this list was loaded. Refresh and try again.');
        await loadRelations(source.id); // restore the canonical ordering
      } else {
        setReorderState('failed');
        setReorderMessage(json?.error ?? 'Could not save the new order.');
        await loadRelations(source.id);
      }
    } catch {
      setRelations(previous);
      setReorderState('failed');
      setReorderMessage('Could not save the new order.');
      await loadRelations(source.id);
    }
  }

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove this related item?"
        message={
          pendingRemove
            ? `"${pendingRemove.related?.title ?? 'This item'}" will stop being shown alongside "${source?.title ?? 'this resource'}". If no manual relationships remain, readers fall back to the automatic category, tag and jurisdiction match instead. You can add it again at any time.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmRemoveRelation}
        onCancel={() => setPendingRemove(null)}
      />

      <div>
        <h1 className="text-2xl font-semibold text-ink">Related Content</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Choose exactly which other resources appear alongside a resource. What you curate here always wins over the
          automatic match, and readers never see a linked resource that is not currently public.
        </p>
      </div>

      <AdminTaskHelp taskId="ADM-16" />

      <div className="max-w-lg rounded-card border border-line bg-white p-4">
        <PostPicker label="Choose a Resource to manage" onPick={setSource} />
        {source && (
          <p className="mt-2 text-sm text-ink">
            Managing: <span className="font-semibold">{source.title}</span>{' '}
            <button type="button" onClick={() => setSource(null)} className="ml-2 text-xs font-semibold text-trust hover:underline">
              Change
            </button>
          </p>
        )}
      </div>

      {source && (
        <div className="rounded-card border border-line bg-white p-4">
          {error && (
            <p role="alert" className="mb-3 text-sm text-risk">
              {error}
            </p>
          )}

          {/* Wave 2 (Scope A): reorder lifecycle feedback. aria-live so a
              screen-reader user hears the outcome of a keyboard reorder
              without having to go looking for it. */}
          <p role="status" aria-live="polite" className={`mb-3 text-sm ${reorderState === 'conflict' || reorderState === 'failed' ? 'text-risk' : 'text-muted'}`}>
            {reorderState === 'saving' ? 'Saving order…' : (reorderMessage ?? '')}
          </p>

          <AdminActionStatus outcome={outcome} className="mb-3" />

          {loading ? (
            <p role="status" aria-live="polite" className="text-sm text-muted">
              Loading related content…
            </p>
          ) : relations.length === 0 ? (
            <p className="text-sm text-muted">No manual relationships yet. The public detail page will fall back to a deterministic category/tag/jurisdiction match.</p>
          ) : (
            <ol className="space-y-2">
              {relations.map((r, i) => (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-compact border border-line p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{r.related?.title ?? '(deleted content)'}</p>
                    <p className="text-xs text-muted">
                      {RELATIONSHIP_TYPE_LABELS[r.relationship_type]}
                      {r.related && (
                        <>
                          {' · '}
                          {formatContentTypeForPicker(r.related.content_type)} · {formatStatusForPicker(r.related.status)}
                          {r.related.status !== 'published' && r.related.status !== 'review_due' && <span className="ml-1 font-semibold text-attention">(not currently public)</span>}
                        </>
                      )}
                    </p>
                  </div>
                  {/* Wave 2 (Scope A): plain Up/Down buttons remain the
                      reorder mechanism (spec §112 — no drag-and-drop
                      required), so reordering is keyboard-accessible by
                      construction. Each button carries an accessible name
                      naming the item it moves, a visible focus ring, and a
                      44x44 minimum target (WCAG 2.2 SC 2.5.8, comfortably
                      above the 24x24 minimum). All three are disabled while
                      a reorder is in flight so a second request cannot race
                      the first. */}
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0 || reorderState === 'saving'}
                        aria-label={`Move ${r.related?.title ?? 'item'} up`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-line text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === relations.length - 1 || reorderState === 'saving'}
                        aria-label={`Move ${r.related?.title ?? 'item'} down`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-line text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingRemove(r)}
                        disabled={reorderState === 'saving' || removing}
                        aria-label={`Remove ${r.related?.title ?? 'item'}`}
                        className="inline-flex min-h-11 items-center justify-center rounded border border-line px-3 text-xs font-semibold text-risk hover:bg-risk/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-risk disabled:opacity-30"
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
              <div className="mb-2 flex items-center gap-3">
                <label htmlFor="relationship-type" className="text-sm font-medium text-ink">
                  Relationship type
                </label>
                <select id="relationship-type" value={relationshipType} onChange={(e) => setRelationshipType(e.target.value as RelationshipType)} className="rounded-compact border border-line bg-white px-2 py-1.5 text-sm">
                  {RELATIONSHIP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {RELATIONSHIP_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <PostPicker label="Add a related Resource" onPick={addRelation} excludeId={source.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
