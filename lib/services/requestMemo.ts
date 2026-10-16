/**
 * Opt-in, request-scoped memoisation (16-10-2026, report generation timeout).
 *
 * Building ONE monthly report used to build the canonical financial snapshot 24
 * times and the dashboard context 20 times (each Score/DNA/Resilience/Goals/
 * Forecast/Recommendation loader called loadDashboard on its own), which meant
 * ~1,300 database round trips for a small household. Inside a scope opened by
 * runWithRequestMemo() the same (user, client, options) read is computed once and
 * every later caller gets an independent deep copy of the result, so a caller
 * that mutates what it received can never change what another caller sees.
 *
 * OUTSIDE a scope this is a plain pass-through: nothing is cached, so every other
 * caller (and every existing test that mutates data between two reads with the
 * same client) behaves byte-identically to before.
 *
 * A failed load is never cached (the next caller retries), and a scope ends when
 * the function it wraps settles, so nothing outlives one report build.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface MemoScope {
  entries: Map<string, Promise<unknown>>;
  hits: number;
  misses: number;
}

const storage = new AsyncLocalStorage<MemoScope>();
const clientIds = new WeakMap<object, number>();
let nextClientId = 1;

/** Stable small id for a client object, so two different clients never share an entry. */
export function memoClientId(client: unknown): string {
  if (client === null || client === undefined || (typeof client !== 'object' && typeof client !== 'function')) return 'none';
  const key = client as object;
  let id = clientIds.get(key);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(key, id);
  }
  return `c${id}`;
}

function cloneResult<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // A value that cannot be cloned (it carries a function) is handed out as is.
    return value;
  }
}

/** Operational kill switch: REPORT_REQUEST_MEMO=off makes every function here a plain pass-through. */
function memoDisabled(): boolean {
  return process.env.REPORT_REQUEST_MEMO === 'off';
}

export function runWithRequestMemo<T>(fn: () => Promise<T>): Promise<T> {
  if (memoDisabled()) return fn();
  // Re-entrant: a nested scope joins the outer one, so work is shared, never duplicated.
  if (storage.getStore()) return fn();
  return storage.run({ entries: new Map(), hits: 0, misses: 0 }, fn);
}

export function requestMemoStats(): { hits: number; misses: number } | null {
  const scope = storage.getStore();
  return scope ? { hits: scope.hits, misses: scope.misses } : null;
}

export async function memoInRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const scope = memoDisabled() ? undefined : storage.getStore();
  if (!scope) return load();
  const existing = scope.entries.get(key) as Promise<T> | undefined;
  if (existing) {
    scope.hits += 1;
    return cloneResult(await existing);
  }
  scope.misses += 1;
  const pending = load();
  scope.entries.set(key, pending);
  pending.catch(() => {
    if (scope.entries.get(key) === pending) scope.entries.delete(key);
  });
  return cloneResult(await pending);
}
