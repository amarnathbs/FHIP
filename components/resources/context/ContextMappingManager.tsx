'use client';

// R1.6 Context Mapping admin — spec §57-58/§78. Left column: pick a
// registered context key (spec §58: only registered keys are selectable at
// all — there is no free-text key entry anywhere in this UI). Right column:
// manage that key's mapped Resources (add/remove/reorder/activate).

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const qp = new URLSearchParams({ q });
      if (excludeId) qp.set('exclude', excludeId);
      const res = await fetch(`/api/admin/resources/related/search-posts?${qp.toString()}`);
      const json = await res.json();
      setResults(res.ok ? json.data : []);
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

export function ContextMappingManager({ canManage }: { canManage: boolean }) {
  const [contextKey, setContextKey] = useState(FHIP_CONTEXTS[0]?.key ?? '');
  const [mappings, setMappings] = useState<ContextMappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeDef = FHIP_CONTEXTS.find((c) => c.key === contextKey);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/resources/context?contextKey=${encodeURIComponent(key)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setMappings(json.data.items);
    } catch {
      setError('Could not load mappings for this context.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (contextKey) void load(contextKey);
  }, [contextKey, load]);

  async function addMapping(post: RelatableSearchResult) {
    const res = await fetch('/api/admin/resources/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_key: contextKey, resource_post_id: post.id, sort_order: mappings.length, is_active: true }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not add this mapping.');
      return;
    }
    await load(contextKey);
  }

  async function toggleActive(m: ContextMappingRow) {
    await fetch(`/api/admin/resources/context/${m.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !m.is_active }),
    });
    await load(contextKey);
  }

  async function remove(id: string) {
    await fetch(`/api/admin/resources/context/${id}`, { method: 'DELETE' });
    await load(contextKey);
  }

  async function move(index: number, direction: -1 | 1) {
    const next = [...mappings];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setMappings(next);
    await Promise.all(next.map((m, i) => fetch(`/api/admin/resources/context/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: i }) })));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">FHIP Contextual Integration — Context Mapping</h1>
        <p className="mt-1 text-sm text-muted">Map registered FHIP context keys to public Resources. The lowest-order active mapping is the one &ldquo;What does this mean?&rdquo; resolves to.</p>
      </div>

      <div className="max-w-md">
        <label htmlFor="context-key-select" className="mb-1 block text-sm font-medium text-ink">
          Context Key
        </label>
        <select id="context-key-select" value={contextKey} onChange={(e) => setContextKey(e.target.value)} className="w-full rounded-compact border border-line bg-white px-3 py-2 text-sm">
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
        {error && (
          <p role="alert" className="mb-3 text-sm text-risk">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : mappings.length === 0 ? (
          <p className="text-sm text-muted">No Resource is mapped to this context yet. The &ldquo;What does this mean?&rdquo; link will render nothing until one is added and active.</p>
        ) : (
          <ol className="space-y-2">
            {mappings.map((m, i) => (
              <li key={m.id} className="flex items-center justify-between gap-3 rounded-compact border border-line p-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{m.resource?.title ?? '(deleted content)'}</p>
                  <p className="text-xs text-muted">
                    {m.resource && (
                      <>
                        {formatContentTypeForPicker(m.resource.content_type)} · {formatStatusForPicker(m.resource.status)}
                        {m.resource.status !== 'published' && m.resource.status !== 'review_due' && <span className="ml-1 font-semibold text-attention">(not currently public — link will not render)</span>}
                      </>
                    )}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m.resource?.title ?? 'item'} up`} className="rounded border border-line px-2 py-1 text-xs disabled:opacity-30">
                      ↑
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === mappings.length - 1} aria-label={`Move ${m.resource?.title ?? 'item'} down`} className="rounded border border-line px-2 py-1 text-xs disabled:opacity-30">
                      ↓
                    </button>
                    <button type="button" onClick={() => toggleActive(m)} className="rounded border border-line px-2 py-1 text-xs font-semibold hover:bg-gray-50">
                      {m.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button" onClick={() => remove(m.id)} className="rounded border border-line px-2 py-1 text-xs font-semibold text-risk hover:bg-risk/5">
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
