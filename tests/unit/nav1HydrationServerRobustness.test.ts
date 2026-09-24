/**
 * NAV 1 Stage D (D.9 follow-up, "path B") — making hydration safe to run on
 * the production server.
 *
 * The second real production run (2026-09-24) produced no history floor and no
 * batch record in 20 minutes. fetchWithRetry had no per-request timeout, so a
 * hung AMFI connection stalled the job until the platform killed it -- with
 * nothing recorded anywhere.
 *
 * Found alongside it: every HTML body AMFI (or anything in front of it) sent
 * parsed to zero rows and was reported as "no data" -- so a block page could
 * have become a fund's permanent history floor.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseFundHouseName } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { fetchWithRetry, DEFAULT_FETCH_TIMEOUT_MS } from '@/lib/services/investment-intelligence/pc6/httpFetchWithRetry';
import {
  AMFI_REQUEST_OPTIONS,
  AmfiHistoricalAdapter,
  classifyAmfiHistoryBody,
} from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';
import type { HistoricalNavAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { runSelectiveHistoricalHydration, type HydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const DATA = [
  'Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date',
  '', 'Open Ended Schemes ( Equity Scheme - Multi Cap Fund )', '', '', 'HDFC Mutual Fund',
  '149366;HDFC Multi Cap Fund - Growth Option;Regular Plan;Growth Option;INF179KC1BV9;;18.589;21-Sep-2026',
  '',
].join('\r\n');
// Excerpt of AMFI's real "no data" page, observed live 2026-09-24 (HTTP 200,
// text/html, ~8 KB) for a window with no data and for a non-existent fund house.
const AMFI_NO_DATA_PAGE =
  '\r\n<!DOCTYPE html>\r\n<html><head><title>\r\n\tView/Download NAV History\r\n</title></head><body>' +
  '<span>View/Download NAV History</span><span>No data found on the basis of selected parameters for this report</span></body></html>';
const BLOCK_PAGE = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';
const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });
const hdfc = async () => 9;

describe('fetchWithRetry now gives up on a request that hangs', () => {
  it('aborts each attempt at the time limit and reports it, instead of waiting forever', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchWithRetry('https://example.test', {}, { timeoutMs: 50, maxAttempts: 2, sleep: async () => {} });
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.failures[0]).toContain('timed out after 50 ms');
  });

  it('leaves a prompt response untouched, and always attaches an abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('hello'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchWithRetry('https://example.test', {});
    expect(res.ok && res.value!.bodyText).toBe('hello');
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeDefined();
  });

  it('has a default limit, so no caller can forget one', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('classifyAmfiHistoryBody', () => {
  it('recognises a NAV history file', () => expect(classifyAmfiHistoryBody(DATA)).toBe('data'));
  it('recognises one that starts with a byte-order mark', () => expect(classifyAmfiHistoryBody('﻿' + DATA)).toBe('data'));
  it("recognises AMFI's own 'no data' page", () => expect(classifyAmfiHistoryBody(AMFI_NO_DATA_PAGE)).toBe('no_data'));
  it('does NOT take a block page for "no data"', () => expect(classifyAmfiHistoryBody(BLOCK_PAGE)).toBe('unrecognised'));
  it('does NOT take an empty body for "no data"', () => expect(classifyAmfiHistoryBody('')).toBe('unrecognised'));
  it('does NOT take a page that merely has the right title for "no data"', () =>
    expect(classifyAmfiHistoryBody('<html><head><title>View/Download NAV History</title></head><body>Service unavailable</body></html>')).toBe('unrecognised'));
});

describe('AmfiHistoricalAdapter reads the response for what it is', () => {
  const adapter = () => new AmfiHistoricalAdapter({ resolveFundHouse: hdfc, today: () => '2026-09-24' });
  const req = { schemeIdentifier: '149366', fromDate: '2026-01-01', toDate: '2026-09-22' }; // 2 AMFI windows

  it("AMFI's 'no data' page in every window means genuinely no data", async () => {
    global.fetch = vi.fn().mockResolvedValue(ok(AMFI_NO_DATA_PAGE)) as unknown as typeof fetch;
    const res = await adapter().fetchHistory(req);
    expect(res.ok ? 'ok' : res.kind).toBe('not_found');
  });

  it("a 'no data' window alongside a data window still returns the data", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(ok(AMFI_NO_DATA_PAGE)).mockResolvedValueOnce(ok(DATA)) as unknown as typeof fetch;
    const res = await adapter().fetchHistory(req);
    expect(res.ok && res.observations).toEqual([{ date: '2026-09-21', nav: '18.589' }]);
  });

  it('a block page is an ERROR (schema_unexpected), never "no data"', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok(BLOCK_PAGE)) as unknown as typeof fetch;
    const res = await adapter().fetchHistory(req);
    expect(res.ok ? 'ok' : res.kind).toBe('schema_unexpected');
  });

  it('AMFI requests carry their own bounded limits (45 s x 3 attempts)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
      global.fetch = fetchMock as unknown as typeof fetch;
      const p = adapter().fetchHistory({ ...req, fromDate: '2026-09-01' });
      await vi.runAllTimersAsync();
      await p;
      expect(fetchMock).toHaveBeenCalledTimes(AMFI_REQUEST_OPTIONS.maxAttempts);
      expect(AMFI_REQUEST_OPTIONS.timeoutMs).toBe(45_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a block page can never become a history floor', () => {
  it('AMFI blocked + TIGZIG empty, with newer data on file: no floor is recorded', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok(BLOCK_PAGE)) as unknown as typeof fetch;
    const tigzigEmpty: HistoricalNavAdapter = {
      providerKey: 'tigzig', adapterVersion: 'v',
      fetchHistory: async (r) => ({
        ok: false, schemeIdentifier: r.schemeIdentifier, kind: 'not_found', detail: 'zero observations',
        provider: { key: 'tigzig', adapterVersion: 'v', requestUrl: null, httpStatus: 200, retrievedAt: 'now' },
      }),
    };
    const recordHistoryFloor = vi.fn().mockResolvedValue({ error: null });
    const deps: HydrationDeps = {
      isEnabled: async () => ({ enabled: true, reason: null }),
      fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies(['i1']),
      fetchBenchmarkDependencies: async () => new Map(),
      fetchEarliestExistingDate: async () => '2018-03-01', // newer data exists -- the exact condition that records a floor
      fetchAdapterIdentifier: async () => '149366',
      fetchExistingObservations: async () => new Map(),
      writeRows: async (rows) => ({ inserted: rows.length, error: null }),
      recordBatch: async () => ({ error: null }),
      fetchHistoryFloor: async () => null,
      recordHistoryFloor,
    };
    const adapter = new FallbackHistoricalAdapter(new AmfiHistoricalAdapter({ resolveFundHouse: hdfc, today: () => '2026-09-24' }), tigzigEmpty);
    const res = await runSelectiveHistoricalHydration({ changeoverDate: '2026-09-21', adapter, deps });
    expect(recordHistoryFloor).not.toHaveBeenCalled();
    expect(res.perInstrument[0].outcome).toBe('fetch_failed');
  });
});

describe('fund-house codes come from the stored table, never from probing AMFI', () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

  it('names compare case- and spacing-insensitively, without altering a single letter', () => {
    // "Sun Life" is deliberate: a regex that lost its backslash (/s+/ instead
    // of /\s+/) strips every letter "s", and matching would still mostly
    // "work" because both sides get mangled alike. Caught during this change.
    expect(normaliseFundHouseName('  Aditya Birla   Sun Life Mutual Fund ')).toBe('aditya birla sun life mutual fund');
    expect(normaliseFundHouseName('HDFC Mutual Fund')).toBe(normaliseFundHouseName('hdfc  mutual  fund'));
  });

  it('the AMFI adapter contains no probe of fund-house codes, and requires a resolver', () => {
    const src = read('lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter.ts');
    expect(src).not.toMatch(/buildAmfiFundHouseMap|defaultResolver|AMFI_MAX_FUND_HOUSE_CODE/);
    expect(src).toContain('constructor(options: AmfiHistoricalAdapterOptions) {'); // no "= {}" default
    expect(src).toMatch(/resolveFundHouse: FundHouseResolver;/); // not optional
  });

  it('migration 0191 seeds one row per fund house, with unique codes and unique names', () => {
    const sql = read('supabase/migrations/0191_nav1_amfi_fund_houses.sql');
    const rows = [...sql.matchAll(/^\s+\((\d+), '((?:[^']|'')+)', '(\d{4}-\d{2}-\d{2})'\)/gm)].map((m) => ({ code: Number(m[1]), name: m[2] }));
    expect(rows.length).toBe(53);
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => normaliseFundHouseName(r.name))).size).toBe(rows.length);
    expect(rows.find((r) => r.code === 9)?.name).toBe('HDFC Mutual Fund'); // matches the live AMFI response captured for these tests
  });
});
