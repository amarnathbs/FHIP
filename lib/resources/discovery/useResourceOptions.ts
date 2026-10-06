'use client';

// PO review F11 — data hook behind components/ui/ResourceCombobox.tsx.
//
// Loads the capped, lightweight list of resources once
// (GET /api/admin/resources/related/search-posts?all=1) and sorts it by title.
// When the server says more rows exist than the cap (`truncated`), anything
// the operator types is ALSO searched server-side (debounced), so a resource
// beyond the cap is still reachable. Outcomes are classified, never swallowed:
// a 403 is "forbidden" (no Retry offered), everything else "error".

import { useEffect, useState } from 'react';
import { readJsonSafely } from '@/lib/resources/admin/resultState';
import { sortPickerOptions, type PickerOption } from '@/lib/resources/discovery/picker';

export type ResourceOptionsStatus = 'loading' | 'ready' | 'error' | 'forbidden';

interface Loaded {
  status: ResourceOptionsStatus;
  items: PickerOption[];
  total: number;
  truncated: boolean;
}

const INITIAL: Loaded = { status: 'loading', items: [], total: 0, truncated: false };

function listUrl(opts: { contentType?: string; excludeId?: string; q?: string }): string {
  const qp = new URLSearchParams({ all: '1' });
  if (opts.contentType) qp.set('type', opts.contentType);
  if (opts.excludeId) qp.set('exclude', opts.excludeId);
  if (opts.q) qp.set('q', opts.q);
  return `/api/admin/resources/related/search-posts?${qp.toString()}`;
}

async function fetchList(opts: { contentType?: string; excludeId?: string; q?: string }): Promise<Loaded> {
  try {
    const res = await fetch(listUrl(opts));
    const json = await readJsonSafely(res);
    if (res.status === 403) return { ...INITIAL, status: 'forbidden' };
    if (!res.ok) return { ...INITIAL, status: 'error' };
    const data = json?.data as { items?: PickerOption[]; total?: number; truncated?: boolean } | undefined;
    if (!data || !Array.isArray(data.items)) return { ...INITIAL, status: 'error' };
    return { status: 'ready', items: sortPickerOptions(data.items), total: data.total ?? data.items.length, truncated: Boolean(data.truncated) };
  } catch {
    return { ...INITIAL, status: 'error' };
  }
}

export function useResourceOptions(opts: { contentType?: string; excludeId?: string; query?: string }) {
  const { contentType, excludeId } = opts;
  const trimmedQuery = (opts.query ?? '').trim();
  const [base, setBase] = useState<Loaded>(INITIAL);
  const [remote, setRemote] = useState<{ q: string; items: PickerOption[] } | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Deferred a tick, like the other Admin loaders, so no state is set
    // synchronously in the effect body.
    const timer = setTimeout(async () => {
      setBase((s) => ({ ...s, status: 'loading' }));
      const result = await fetchList({ contentType, excludeId });
      if (!cancelled) setBase(result);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contentType, excludeId, token]);

  const truncated = base.truncated;
  useEffect(() => {
    let cancelled = false;
    if (!truncated || !trimmedQuery) {
      const timer = setTimeout(() => {
        if (!cancelled) setRemote(null);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    const timer = setTimeout(async () => {
      const result = await fetchList({ contentType, excludeId, q: trimmedQuery });
      if (!cancelled && result.status === 'ready') setRemote({ q: trimmedQuery, items: result.items });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [truncated, trimmedQuery, contentType, excludeId]);

  const options = truncated && remote && remote.q === trimmedQuery ? remote.items : base.items;

  return {
    status: base.status,
    options,
    total: base.total,
    truncated,
    retry: () => setToken((t) => t + 1),
  };
}
