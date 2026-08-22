'use client';

// R1.6 Related Content admin — spec §39/§77. Standalone screen (see
// lib/resources/discovery/relatedAdmin.ts's header for why this is not a
// panel bolted onto the certified R1.3 editor). Step 1: pick a source
// Resource (title search, staff sees every status). Step 2: manage that
// source's manual relationships — add (search + relationship type), remove,
// reorder with plain Up/Down buttons (spec §112: "Do not require
// drag-and-drop").

import { useCallback, useEffect, useRef, useState } from 'react';
import { RELATIONSHIP_TYPES, RELATIONSHIP_TYPE_LABELS, formatStatusForPicker, formatContentTypeForPicker, type RelationshipType, type RelatedContentAdminRow, type RelatableSearchResult } from '@/lib/resources/discovery/relatedAdmin';

function PostPicker({ onPick, excludeId, label }: { onPick: (post: RelatableSearchResult) => void; excludeId?: string; label: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RelatableSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Every branch schedules its state update inside the timeout (even the
    // empty-query "clear" case) rather than calling setState synchronously
    // in the effect body.
    debounceRef.current = setTimeout(async () => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const qp = new URLSearchParams({ q });
        if (excludeId) qp.set('exclude', excludeId);
        const res = await fetch(`/api/admin/resources/related/search-posts?${qp.toString()}`);
        const json = await res.json();
        setResults(res.ok ? json.data : []);
      } finally {
        setLoading(false);
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
      {loading && <p className="mt-1 text-xs text-muted">Searching…</p>}
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
                }}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-gray-50"
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
      if (source) void loadRelations(source.id);
    }, 0);
    return () => clearTimeout(timer);
  }, [source, loadRelations]);

  async function addRelation(target: RelatableSearchResult) {
    if (!source) return;
    setError(null);
    const res = await fetch('/api/admin/resources/related', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_post_id: source.id, related_post_id: target.id, relationship_type: relationshipType }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not add this relationship.');
      return;
    }
    await loadRelations(source.id);
  }

  async function removeRelation(id: string) {
    if (!source) return;
    const res = await fetch(`/api/admin/resources/related/${id}`, { method: 'DELETE' });
    if (res.ok) await loadRelations(source.id);
  }

  async function move(index: number, direction: -1 | 1) {
    if (!source) return;
    const next = [...relations];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRelations(next);
    await fetch('/api/admin/resources/related/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_post_id: source.id, ordered_ids: next.map((r) => r.id) }),
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Related Content</h1>
        <p className="mt-1 text-sm text-muted">Manually curated relationships always take priority over the deterministic fallback (spec §29-30). Public readers never see a linked Resource that isn&rsquo;t currently public.</p>
      </div>

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

          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
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
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${r.related?.title ?? 'item'} up`} className="rounded border border-line px-2 py-1 text-xs disabled:opacity-30">
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === relations.length - 1} aria-label={`Move ${r.related?.title ?? 'item'} down`} className="rounded border border-line px-2 py-1 text-xs disabled:opacity-30">
                        ↓
                      </button>
                      <button type="button" onClick={() => removeRelation(r.id)} className="rounded border border-line px-2 py-1 text-xs font-semibold text-risk hover:bg-risk/5">
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
