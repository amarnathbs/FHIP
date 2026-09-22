// PC6/NAV 1 — reusable HTTP retry-with-backoff, extracted from the pattern
// proven live in scripts/pc6_historical_nav_backfill.mjs (commit 237a2f8,
// 2026-09-20) after a real production run hit a CDN/WAF block page —
// returning HTML, not PostgREST's JSON error shape — under sustained
// request volume. That fix lived only inside a one-off script; NAV 1.14's
// provider-neutral adapter contract needs the same defensive behaviour for
// TIGZIG/mfnav, so it is lifted here as a shared, unit-tested utility rather
// than re-implemented per adapter.
//
// This module does not know about Supabase, PostgREST, or AMFI — it retries
// a caller-supplied fetch, nothing more.

export interface RetryOptions {
  /** Total attempts, including the first. Default 6 (matches the backfill script). */
  maxAttempts?: number;
  /** Base delay before the first retry, in ms. Default 1000. */
  baseDelayMs?: number;
  /** Ceiling for exponential backoff, in ms. Default 30000. */
  maxDelayMs?: number;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests/logging; defaults to a no-op. */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => void;
}

export interface RetryResult<T> {
  ok: boolean;
  /** Present when ok is true. */
  value?: T;
  /** Present when ok is false: every attempt's failure reason, in order. */
  failures: string[];
  attemptsMade: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A CDN/WAF/rate-limit block page comes back as HTML, not a provider's own
 * JSON error shape — the exact failure class this repository has already
 * hit live against Supabase's REST API (2026-09-20) and must assume any
 * third-party market-data HTTP source can hit too.
 */
export function looksLikeBlockPage(bodyText: string): boolean {
  return bodyText.trim().startsWith('<');
}

/**
 * Runs `attempt()` up to `maxAttempts` times with exponential backoff.
 * `attempt()` should throw (or return a result whose `retryable` is true)
 * to trigger a retry; any other return value is treated as success.
 *
 * Kept generic rather than fetch-specific so both a real `fetch()` call and
 * a test double can be exercised identically.
 */
export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<{ retryable: false; value: T } | { retryable: true; reason: string }>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const sleep = options.sleep ?? defaultSleep;
  const failures: string[] = [];

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    let outcome: { retryable: false; value: T } | { retryable: true; reason: string };
    try {
      outcome = await attempt(attemptNumber);
    } catch (e) {
      outcome = { retryable: true, reason: e instanceof Error ? e.message : String(e) };
    }

    if (!outcome.retryable) {
      return { ok: true, value: outcome.value, failures, attemptsMade: attemptNumber };
    }

    failures.push(outcome.reason);
    if (attemptNumber === maxAttempts) {
      return { ok: false, failures, attemptsMade: attemptNumber };
    }
    const delayMs = Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
    options.onRetry?.({ attempt: attemptNumber, maxAttempts, delayMs, reason: outcome.reason });
    await sleep(delayMs);
  }
  // Unreachable, but keeps the return type total.
  return { ok: false, failures, attemptsMade: maxAttempts };
}

/**
 * Convenience wrapper for the common case: retry a `fetch()` call itself,
 * classifying a non-2xx response or an HTML block-page body as retryable.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<RetryResult<{ status: number; bodyText: string }>> {
  return withRetry(async () => {
    const res = await fetch(url, init);
    const bodyText = await res.text();
    if (res.ok) return { retryable: false, value: { status: res.status, bodyText } };
    const blockPage = looksLikeBlockPage(bodyText);
    return {
      retryable: true,
      reason: `HTTP ${res.status}${blockPage ? ' (HTML block page, not a provider error)' : ''}: ${bodyText.slice(0, 200)}`,
    };
  }, options);
}
