/**
 * NAV 1 Stage D (D.3) — AMFI primary / TIGZIG fallback for on-demand
 * historical hydration (PO decision 2026-09-24).
 *
 * The AMFI fixture below is made of REAL lines captured from
 * portal.amfiindia.com on 2026-09-24 (mf=9, HDFC Mutual Fund), including the
 * header, category and fund-house lines, so the production parser is exercised
 * against the genuine format rather than one invented for the test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PC6_REFERENCE_SOURCES } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import {
  AMFI_MAX_REQUEST_DAYS,
  AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY,
  AmfiHistoricalAdapter,
  buildAmfiFundHouseMap,
  splitAmfiWindow,
} from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';
import type {
  HistoricalNavAdapter,
  HistoricalNavAdapterResult,
  HistoricalNavRequest,
} from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import {
  runSelectiveHistoricalHydration,
  type HydrationDeps,
  type HydrationWriteRow,
} from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const REAL_AMFI_FUND_HOUSE_RESPONSE = [
  'Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date',
  '',
  'Open Ended Schemes ( Equity Scheme - Multi Cap Fund )',
  '',
  '',
  'HDFC Mutual Fund',
  '149366;HDFC Multi Cap Fund - Growth Option;Regular Plan;Growth Option;INF179KC1BV9;;18.589;21-Sep-2026',
  '149366;HDFC Multi Cap Fund - Growth Option;Regular Plan;Growth Option;INF179KC1BV9;;18.546;22-Sep-2026',
  '149368;HDFC Multi Cap Fund - Growth Option - Direct Plan;Direct Plan;Growth Option;INF179KC1BS5;;19.637;21-Sep-2026',
  '149368;HDFC Multi Cap Fund - Growth Option - Direct Plan;Direct Plan;Growth Option;INF179KC1BS5;;19.592;22-Sep-2026',
  '149365;HDFC Multi Cap Fund - IDCW Option;Regular Plan;IDCW Option;INF179KC1BW7;INF179KC1BX5;16.84;21-Sep-2026',
  '149365;HDFC Multi Cap Fund - IDCW Option;Regular Plan;IDCW Option;INF179KC1BW7;INF179KC1BX5;16.801;22-Sep-2026',
  '',
].join('\r\n');

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
const resolveHdfc = async (code: string) => (['149366', '149368', '149365'].includes(code) ? 9 : null);
const fixedToday = () => '2026-09-24';

afterEach(() => {
  vi.useRealTimers();
  PC6_REFERENCE_SOURCES.amfi_nav_history.enabled = true;
  PC6_REFERENCE_SOURCES.tigzig_nav_history.enabled = true;
});

describe('AmfiHistoricalAdapter', () => {
  it('picks the one requested scheme out of a whole-fund-house response, keeping the NAV string exact', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok(REAL_AMFI_FUND_HOUSE_RESPONSE)) as unknown as typeof fetch;
    const adapter = new AmfiHistoricalAdapter({ resolveFundHouse: resolveHdfc, today: fixedToday });
    const res = await adapter.fetchHistory({ schemeIdentifier: '149366', fromDate: '2026-09-19', toDate: '2026-09-22' });
    if (!res.ok) throw new Error(`expected ok, got ${res.kind}: ${res.detail}`);
    expect(res.observations).toEqual([
      { date: '2026-09-21', nav: '18.589' },
      { date: '2026-09-22', nav: '18.546' },
    ]);
    expect(res.providerSchemeName).toBe('HDFC Multi Cap Fund - Growth Option');
    expect(res.provider.key).toBe('amfi');
    expect(res.coverage).toBe('unknown'); // never claims completeness it cannot know
  });

  it('filters every request to the resolved fund house', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(REAL_AMFI_FUND_HOUSE_RESPONSE));
    global.fetch = fetchMock as unknown as typeof fetch;
    await new AmfiHistoricalAdapter({ resolveFundHouse: resolveHdfc, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '149366', fromDate: '2026-09-19', toDate: '2026-09-22' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('&mf=9');
    expect(url).toContain('frmdt=19-Sep-2026');
    expect(url).toContain('todt=22-Sep-2026');
  });

  it(`splits a 730-day hydration chunk into requests of at most ${AMFI_MAX_REQUEST_DAYS} days`, async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(REAL_AMFI_FUND_HOUSE_RESPONSE));
    global.fetch = fetchMock as unknown as typeof fetch;
    await new AmfiHistoricalAdapter({ resolveFundHouse: resolveHdfc, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '149366', fromDate: '2024-09-22', toDate: '2026-09-21' });
    expect(fetchMock).toHaveBeenCalledTimes(Math.ceil(730 / AMFI_MAX_REQUEST_DAYS));
  });

  it('reports not_found -- with no request made -- when AMFI does not publish the scheme', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await new AmfiHistoricalAdapter({ resolveFundHouse: async () => null, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '999999', fromDate: '2026-09-19', toDate: '2026-09-22' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_found when the fund house has no row for the scheme in the window', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok(REAL_AMFI_FUND_HOUSE_RESPONSE)) as unknown as typeof fetch;
    const res = await new AmfiHistoricalAdapter({ resolveFundHouse: async () => 9, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '100001', fromDate: '2026-09-19', toDate: '2026-09-22' });
    expect(res.ok ? 'ok' : res.kind).toBe('not_found');
  });

  it('classifies a sustained 429 as rate_limited', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'busy' }) as unknown as typeof fetch;
    const p = new AmfiHistoricalAdapter({ resolveFundHouse: resolveHdfc, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '149366', fromDate: '2026-09-19', toDate: '2026-09-22' });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.ok ? 'ok' : res.kind).toBe('rate_limited');
  });

  it('refuses before any network call when the registry disables the source', async () => {
    PC6_REFERENCE_SOURCES.amfi_nav_history.enabled = false;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await new AmfiHistoricalAdapter({ resolveFundHouse: resolveHdfc, today: fixedToday })
      .fetchHistory({ schemeIdentifier: '149366', fromDate: '2026-09-19', toDate: '2026-09-22' });
    expect(res.ok ? 'ok' : res.kind).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('splitAmfiWindow', () => {
  it('covers the window exactly, oldest first, with no gaps or overlaps', () => {
    const w = splitAmfiWindow('2026-01-01', '2026-12-31', 180);
    expect(w[0].fromDate).toBe('2026-01-01');
    expect(w.at(-1)!.toDate).toBe('2026-12-31');
    for (let i = 1; i < w.length; i++) {
      const prevEnd = new Date(`${w[i - 1].toDate}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
      expect(w[i].fromDate).toBe(prevEnd.toISOString().slice(0, 10));
    }
  });

  it('handles a single day', () => {
    expect(splitAmfiWindow('2026-09-22', '2026-09-22')).toEqual([{ fromDate: '2026-09-22', toDate: '2026-09-22' }]);
  });
});

describe('buildAmfiFundHouseMap', () => {
  it('skips a thin day (weekend / holiday) and maps every scheme on the next full day to its fund house', async () => {
    const full = Array.from({ length: AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY }, (_, i) => `${200000 + i};Fund ${i};Regular Plan;Growth Option;;;10.0;22-Sep-2026`);
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const mf = Number(/&mf=(\d+)/.exec(url)![1]);
      const thinDay = url.includes('frmdt=23-Sep-2026');
      if (thinDay) return ok(mf === 1 ? '100001;Liquid;Regular Plan;Growth Option;;;1000;23-Sep-2026' : '');
      if (mf === 1) return ok(full.slice(0, 2600).join('\n'));
      if (mf === 89) return ok(full.slice(2600).join('\n'));
      return ok('');
    }) as unknown as typeof fetch;
    const { referenceDate, map } = await buildAmfiFundHouseMap('2026-09-24');
    expect(referenceDate).toBe('2026-09-22'); // 23 Sep had one liquid fund -- rejected as a reference day
    expect(map.size).toBe(AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY);
    expect(map.get('200000')).toBe(1);
    expect(map.get(String(200000 + AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY - 1))).toBe(89);
  });
});

describe('TigzigHistoricalAdapter honours the registry', () => {
  it('refuses before any network call when tigzig_nav_history is disabled', async () => {
    PC6_REFERENCE_SOURCES.tigzig_nav_history.enabled = false;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await new TigzigHistoricalAdapter().fetchHistory({ schemeIdentifier: '149366', fromDate: '2026-09-19', toDate: '2026-09-22' });
    expect(res.ok ? 'ok' : res.kind).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is enabled in the registry as the PO-approved fallback', () => {
    expect(PC6_REFERENCE_SOURCES.tigzig_nav_history.enabled).toBe(true);
    expect(PC6_REFERENCE_SOURCES.tigzig_nav_history.notes).toContain('APPROVED AS FALLBACK ONLY');
  });
});

// --- Fallback composite -------------------------------------------------------

function stub(key: string, result: (r: HistoricalNavRequest) => HistoricalNavAdapterResult): HistoricalNavAdapter & { calls: number } {
  const a = {
    providerKey: key,
    adapterVersion: `${key}-v1`,
    calls: 0,
    async fetchHistory(r: HistoricalNavRequest) { a.calls++; return result(r); },
  };
  return a;
}
const success = (key: string) => (r: HistoricalNavRequest): HistoricalNavAdapterResult => ({
  ok: true, schemeIdentifier: r.schemeIdentifier, providerSchemeName: null,
  observations: [{ date: r.toDate, nav: '10.5' }], coverage: 'unknown',
  provider: { key, adapterVersion: `${key}-v1`, requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: `${key}checksum000` },
});
const failure = (key: string, kind: 'not_found' | 'http_error') => (r: HistoricalNavRequest): HistoricalNavAdapterResult => ({
  ok: false, schemeIdentifier: r.schemeIdentifier, kind, detail: `${key} ${kind}`,
  provider: { key, adapterVersion: `${key}-v1`, requestUrl: null, httpStatus: null, retrievedAt: 'now' },
});
const REQ = { schemeIdentifier: '149366', fromDate: '2026-01-01', toDate: '2026-01-31' };

describe('FallbackHistoricalAdapter', () => {
  it('uses the primary alone when it succeeds -- the fallback is never consulted', async () => {
    const amfi = stub('amfi', success('amfi'));
    const tig = stub('tigzig', success('tigzig'));
    const res = await new FallbackHistoricalAdapter(amfi, tig).fetchHistory(REQ);
    expect(res.ok && res.provider.key).toBe('amfi');
    expect(tig.calls).toBe(0);
  });

  it('falls back when the primary fails, and the result names the source that actually served it', async () => {
    const res = await new FallbackHistoricalAdapter(stub('amfi', failure('amfi', 'not_found')), stub('tigzig', success('tigzig'))).fetchHistory(REQ);
    expect(res.ok && res.provider.key).toBe('tigzig');
  });

  it('reports not_found only when BOTH sources say so', async () => {
    const res = await new FallbackHistoricalAdapter(stub('amfi', failure('amfi', 'not_found')), stub('tigzig', failure('tigzig', 'not_found'))).fetchHistory(REQ);
    expect(res.ok ? 'ok' : res.kind).toBe('not_found');
    if (!res.ok) expect(res.detail).toMatch(/amfi.*tigzig/);
  });

  it('never turns a real primary failure into "no history exists"', async () => {
    const res = await new FallbackHistoricalAdapter(stub('amfi', failure('amfi', 'http_error')), stub('tigzig', failure('tigzig', 'not_found'))).fetchHistory(REQ);
    expect(res.ok ? 'ok' : res.kind).toBe('http_error');
  });
});

describe('hydration stamps each row with the provider that actually supplied it', () => {
  it('rows served by the TIGZIG fallback are labelled tigzig, not the composite and not amfi', async () => {
    const written: HydrationWriteRow[] = [];
    const deps: HydrationDeps = {
      isEnabled: async () => ({ enabled: true, reason: null }),
      fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies(['inst-1']),
      fetchBenchmarkDependencies: async () => new Map(),
      fetchEarliestExistingDate: async () => null,
      fetchAdapterIdentifier: async () => '149366',
      fetchExistingObservations: async () => new Map(),
      writeRows: async (rows) => { written.push(...rows); return { inserted: rows.length, error: null }; },
      recordBatch: async () => ({ error: null }),
      fetchHistoryFloor: async () => null,
      recordHistoryFloor: async () => ({ error: null }),
    };
    const adapter = new FallbackHistoricalAdapter(stub('amfi', failure('amfi', 'not_found')), stub('tigzig', success('tigzig')));
    const result = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter, deps });
    expect(result.totalRowsInserted).toBeGreaterThan(0);
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) expect(row.dataVersion.startsWith('tigzig:')).toBe(true);
  });
});

describe('the hydration route is wired to AMFI primary, TIGZIG fallback', () => {
  it('constructs the fallback composite in that order', () => {
    const route = readFileSync(path.resolve(__dirname, '../../app/api/investment-intelligence/cron/pc6-selective-hydration/route.ts'), 'utf8');
    expect(route).toContain('new FallbackHistoricalAdapter(new AmfiHistoricalAdapter(), new TigzigHistoricalAdapter())');
  });
});
