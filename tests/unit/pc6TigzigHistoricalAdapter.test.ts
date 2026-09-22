// PC6/NAV 1.15 — unit tests for the TIGZIG historical adapter, using a
// mocked fetch. The fixture response below is the ACTUAL body this session
// observed live from https://api.tigzig.com/mf/v1/nav on 2026-09-21 for
// scheme 119551 / 2026-09-14..2026-09-18 (see the adapter's own header
// comment) — not an invented example.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';

const REAL_FIXTURE = {
  scheme_code: 119551,
  scheme_name: 'Aditya Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW',
  isin: 'INF209KA12Z1',
  isin2: 'INF209KA13Z9',
  first_available_date: '2013-01-02',
  latest_available_date: '2026-09-18',
  count: 4,
  data: [
    { date: '2026-09-15', nav: 106.9321 },
    { date: '2026-09-16', nav: 106.9851 },
    { date: '2026-09-17', nav: 107.0008 },
    { date: '2026-09-18', nav: 107.0677 },
  ],
};

describe('TigzigHistoricalAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('parses the real observed TIGZIG response shape into normalized candidate observations', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify(REAL_FIXTURE),
    }) as unknown as typeof fetch;

    const adapter = new TigzigHistoricalAdapter();
    const result = await adapter.fetchHistory({ schemeIdentifier: '119551', fromDate: '2026-09-14', toDate: '2026-09-18' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.observations).toHaveLength(4);
    expect(result.observations[0]).toEqual({ date: '2026-09-15', nav: '106.9321' });
    expect(result.providerSchemeName).toBe('Aditya Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW');
    // Never asserted complete from count alone — see adapter header.
    expect(result.coverage).toBe('unknown');
    expect(result.provider.key).toBe('tigzig');
  });

  it('reports not_found rather than a false empty success when count is 0', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ scheme_code: 999999, count: 0, data: [] }),
    }) as unknown as typeof fetch;

    const adapter = new TigzigHistoricalAdapter();
    const result = await adapter.fetchHistory({ schemeIdentifier: '999999', fromDate: '2026-01-01', toDate: '2026-01-02' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('not_found');
  });

  it('reports schema_unexpected rather than silently accepting a shape drift', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ unexpected: 'shape' }),
    }) as unknown as typeof fetch;

    const adapter = new TigzigHistoricalAdapter();
    const result = await adapter.fetchHistory({ schemeIdentifier: '119551', fromDate: '2026-01-01', toDate: '2026-01-02' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('schema_unexpected');
  });

  it('classifies a sustained 429 as rate_limited after retry exhaustion', async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":"rate limited"}' }) as unknown as typeof fetch;
      const adapter = new TigzigHistoricalAdapter();
      const resultPromise = adapter.fetchHistory({ schemeIdentifier: '119551', fromDate: '2026-01-01', toDate: '2026-01-02' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.kind).toBe('rate_limited');
    } finally {
      vi.useRealTimers();
    }
  });
});
