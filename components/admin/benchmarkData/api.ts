'use client';

// Browser-side fetch helpers for the Market Index Data Admin screens. Same-origin
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

/** GET `url` and unwrap `{ data }`. Reload with `reload()`. Previously loaded data stays on screen while a reload runs. */
export function useLoad<T>(url: string | null, action: string): { state: LoadState<T>; reload: () => void } {
  const [res, setRes] = useState<{ key: string; value: Exclude<LoadState<T>, { status: 'loading' }> } | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${url ?? ''}|${tick}`;
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    (async () => {
      const r = await apiCall(url, { signal: ac.signal });
      if (ac.signal.aborted || r.aborted) return;
      if (!r.ok) {
        setRes({ key, value: { status: 'error', failure: failureOf(r, action) } });
        return;
      }
      const data = r.body && 'data' in r.body ? (r.body.data as T) : null;
      if (data === null || data === undefined) {
        setRes({ key, value: { status: 'error', failure: { kind: 'error', message: 'The server answered in an unexpected shape, so nothing is shown rather than something wrong.', restart: false, retryable: true } } });
        return;
      }
      setRes({ key, value: { status: 'ready', data } });
    })();
    return () => ac.abort();
  }, [url, action, key]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const state: LoadState<T> = res && (res.value.status === 'ready' || res.key === key) ? res.value : { status: 'loading' };
  return { state, reload };
}

export type Say = (kind: 'success' | 'failure', message: string) => void;

/** POST JSON, announce the outcome, and report the plain-language message back (used for inline display too). */
export function usePost(say: Say): { busy: boolean; post: (path: string, json: unknown, okMessage: string, action: string) => Promise<{ ok: boolean; message: string; body: Record<string, unknown> | null }> } {
  const signal = useUnmountSignal();
  const [busy, setBusy] = useState(false);
  const post = useCallback(
    async (path: string, json: unknown, okMessage: string, action: string) => {
      setBusy(true);
      const r = await apiCall(path, { method: 'POST', json, signal: signal() });
      if (r.aborted) return { ok: false, message: '', body: null };
      setBusy(false);
      if (r.ok) {
        say('success', okMessage);
        return { ok: true, message: okMessage, body: r.body };
      }
      const message = failureOf(r, action).message;
      say('failure', message);
      return { ok: false, message, body: r.body };
    },
    [say, signal]
  );
  return { busy, post };
}
