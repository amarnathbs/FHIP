'use client';

// Browser-side fetch helpers for the Benchmark Data Admin screens. Same-origin
// credentials, a signal for every request (aborted on unmount), JSON read
// safely (an HTML error page from an edge proxy never becomes the message an
// administrator sees). No authorisation decision is made here: the server and
// the database enforce every capability (Admin Architecture Standard section 4).
import { useCallback, useEffect, useRef, useState } from 'react';
import { readJsonSafely } from '@/lib/resources/admin/resultState';
import { describeApiFailure, type ApiFailure } from './benchmarkDataUiLogic';

export interface ApiResult {
  ok: boolean;
  /** 0 = the server could not be reached (or the request was aborted). */
  status: number;
  body: Record<string, unknown> | null;
  aborted: boolean;
}

export async function apiCall(url: string, init: { method?: 'GET' | 'POST'; json?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<ApiResult> {
  try {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await fetch(url, { method: init.method ?? 'GET', credentials: 'same-origin', headers, body, signal: init.signal });
    const parsed = await readJsonSafely(res);
    return { ok: res.ok, status: res.status, body: parsed, aborted: false };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return { ok: false, status: 0, body: null, aborted };
  }
}

export function failureOf(r: ApiResult, action: string): ApiFailure {
  if (r.status === 0) return { kind: 'unavailable', message: 'The server could not be reached. Nothing was changed. Check your connection and try again.', restart: false, retryable: true };
  return describeApiFailure(r.status, r.body, action);
}

/** An AbortSignal that is aborted when the component unmounts. */
export function useUnmountSignal(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => {
    ref.current = new AbortController();
    return () => ref.current?.abort();
  }, []);
  return useCallback(() => {
    if (!ref.current) ref.current = new AbortController();
    return ref.current.signal;
  }, []);
}

export type LoadState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; failure: ApiFailure };

/** GET `url` and unwrap `{ data }`. Reload with `reload()`. */
export function useLoad<T>(url: string | null, action: string): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    (async () => {
      const r = await apiCall(url, { signal: ac.signal });
      if (ac.signal.aborted || r.aborted) return;
      if (!r.ok) {
        setState({ status: 'error', failure: failureOf(r, action) });
        return;
      }
      const data = r.body && 'data' in r.body ? (r.body.data as T) : null;
      if (data === null || data === undefined) {
        setState({ status: 'error', failure: { kind: 'error', message: 'The server answered in an unexpected shape, so nothing is shown rather than something wrong.', restart: false, retryable: true } });
        return;
      }
      setState({ status: 'ready', data });
    })();
    return () => ac.abort();
  }, [url, action, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}
