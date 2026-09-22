// PC6/NAV 1 — unit tests for the shared HTTP retry-with-backoff utility.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, fetchWithRetry, looksLikeBlockPage } from '@/lib/services/investment-intelligence/pc6/httpFetchWithRetry';

describe('looksLikeBlockPage', () => {
  it('flags an HTML body as a block page', () => {
    expect(looksLikeBlockPage('<!DOCTYPE html><html>blocked</html>')).toBe(true);
  });
  it('does not flag a JSON body', () => {
    expect(looksLikeBlockPage('{"error": "bad request"}')).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns success immediately when the first attempt succeeds', async () => {
    const attempt = vi.fn().mockResolvedValue({ retryable: false, value: 42 });
    const result = await withRetry(attempt, { sleep: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and eventually succeeds', async () => {
    let calls = 0;
    const attempt = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) return { retryable: true, reason: `fail ${calls}` };
      return { retryable: false, value: 'ok' };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(attempt, { maxAttempts: 5, sleep });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and reports every failure reason', async () => {
    const attempt = vi.fn().mockResolvedValue({ retryable: true, reason: 'always fails' });
    const result = await withRetry(attempt, { maxAttempts: 3, sleep: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.attemptsMade).toBe(3);
    expect(result.failures).toHaveLength(3);
  });

  it('treats a thrown exception the same as an explicit retryable result', async () => {
    let calls = 0;
    const attempt = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('network reset');
      return { retryable: false, value: 'recovered' };
    });
    const result = await withRetry(attempt, { sleep: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual(['network reset']);
  });

  it('uses exponential backoff delays, capped at maxDelayMs', async () => {
    const attempt = vi.fn().mockResolvedValue({ retryable: true, reason: 'x' });
    const delays: number[] = [];
    await withRetry(attempt, {
      maxAttempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([1000, 2000, 3000]); // 1000*2^0, 1000*2^1, capped at 3000 (would be 4000)
  });
});

describe('fetchWithRetry', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('succeeds on a 200 response without retrying', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"count":1}' }) as unknown as typeof fetch;
    const result = await fetchWithRetry('https://example.test/x', {}, { sleep: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.value?.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an HTML block-page response and eventually fails with the reason recorded', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '<!DOCTYPE html>blocked' }) as unknown as typeof fetch;
    const result = await fetchWithRetry('https://example.test/x', {}, { maxAttempts: 2, sleep: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('HTML block page');
  });
});
