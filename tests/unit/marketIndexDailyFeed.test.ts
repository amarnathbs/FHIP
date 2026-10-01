// Daily market-index updater: disabled by default, fails closed, never calls a
// live site from a test (every request goes to a recorded-fixture double),
// never routes around bot protection.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSupabase } from '../fixtures/fakeSupabase';
import {
  bseSensexAdapter,
  fetchCloseForDate,
  nseNifty50Adapter,
  recentWeekdays,
  runMarketIndexDailyUpdate,
  FEED_USER_AGENT,
  RATE_LIMIT_MS,
  type FeedHttp,
} from '@/lib/services/investment-intelligence/marketIndex/dailyFeed';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'market-index');
const NSE_FILE = fs.readFileSync(path.join(FIX, 'nse_ind_close_all_06032024.csv'), 'utf8');
const BSE_FILE = fs.readFileSync(path.join(FIX, 'bse_archive_layout.csv'), 'utf8');
const ROOT = path.resolve(__dirname, '..', '..');

// Wednesday 2024-03-06 12:00 UTC.
const NOW = '2024-03-06T12:00:00.000Z';

function httpDouble(responder: (url: string) => { status: number; bodyText: string }) {
  const get = vi.fn(async (url: string, headers: Record<string, string>) => (void headers, responder(url)));
  const sleep = vi.fn(async (ms: number) => void ms);
  const http: FeedHttp = { get, sleep };
  return { http, get, sleep };
}

function controlRow(over: Record<string, unknown> = {}) {
  return { job_key: 'market_index_daily_close', enabled: true, disabled_reason: null, consecutive_failures: 0, next_attempt_not_before: null, last_success_at: null, ...over };
}
function tables(over: Record<string, Array<Record<string, unknown>>> = {}) {
  return {
    ii_reference_job_control: [controlRow()],
    ii_benchmarks: [{ id: 'b-n', benchmark_key: 'IN_NIFTY_50_PRI' }, { id: 'b-s', benchmark_key: 'IN_SENSEX_PRI' }],
    ii_benchmark_series: [],
    ...over,
  };
}
const ENV_ON = { MARKET_INDEX_FEED_ENABLED: 'true', MARKET_INDEX_BSE_CSV_URL_TEMPLATE: 'https://example.test/bse/{DDMMYYYY}.csv' };

describe('disabled by default (fails closed, no I/O)', () => {
  it('with the environment switch absent, NO request is made and the database is not touched', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const db = fakeSupabase(tables());
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: {}, nowIso: NOW });
    expect(r.status).toBe('disabled_env');
    expect(get).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });
  it.each(['TRUE', '1', 'yes', 'false', ''])('the environment switch must be exactly "true" ("%s" is off)', async (v) => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const r = await runMarketIndexDailyUpdate({ supabase: fakeSupabase(tables()).client, http, env: { MARKET_INDEX_FEED_ENABLED: v }, nowIso: NOW });
    expect(r.status).toBe('disabled_env');
    expect(get).not.toHaveBeenCalled();
  });
  it('environment ON but the database kill switch OFF: still no request', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const db = fakeSupabase(tables({ ii_reference_job_control: [controlRow({ enabled: false, disabled_reason: 'terms not confirmed' })] }));
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: ENV_ON, nowIso: NOW });
    expect(r.status).toBe('skipped_kill_switch');
    expect(r.detail).toMatch(/terms not confirmed/);
    expect(get).not.toHaveBeenCalled();
  });
  it('environment ON but NO control row at all: fails closed', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const db = fakeSupabase(tables({ ii_reference_job_control: [] }));
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: ENV_ON, nowIso: NOW });
    expect(r.status).toBe('skipped_kill_switch');
    expect(get).not.toHaveBeenCalled();
  });
  it('backoff after failures is honoured', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const db = fakeSupabase(tables({ ii_reference_job_control: [controlRow({ consecutive_failures: 2, next_attempt_not_before: '2024-03-06T18:00:00.000Z' })] }));
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: ENV_ON, nowIso: NOW });
    expect(r.status).toBe('skipped_backoff');
    expect(get).not.toHaveBeenCalled();
  });
  it('the shipped migration registers the job disabled and creates no schedule; the route is wired to the same switches', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0232_market_index_data_upload_and_feed.sql'), 'utf8');
    expect(sql).toMatch(/'market_index_daily_close', false,/);
    expect(sql).not.toMatch(/cron\.schedule/i);
    const route = fs.readFileSync(path.join(ROOT, 'app/api/investment-intelligence/cron/market-index-daily/route.ts'), 'utf8');
    expect(route).toMatch(/x-cron-secret/);
    expect(route).toMatch(/MARKET_INDEX_FEED_ENABLED !== 'true'/);
  });
});

describe('the cron route authenticates like every other scheduled job', () => {
  it('no secret / wrong secret -> 401 and nothing runs', async () => {
    process.env.CRON_SECRET = 'right';
    const { POST } = await import('@/app/api/investment-intelligence/cron/market-index-daily/route');
    expect((await POST(new Request('http://t/x', { method: 'POST' }))).status).toBe(401);
    expect((await POST(new Request('http://t/x', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }))).status).toBe(401);
  });
  it('right secret with the feed off: 200, status disabled_env, no request', async () => {
    process.env.CRON_SECRET = 'right';
    delete process.env.MARKET_INDEX_FEED_ENABLED;
    const { POST } = await import('@/app/api/investment-intelligence/cron/market-index-daily/route');
    const res = await POST(new Request('http://t/x', { method: 'POST', headers: { 'x-cron-secret': 'right' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: 'disabled_env', requests_made: 0 });
  });
});

describe('recorded-fixture parsing through the adapters', () => {
  it('NSE adapter builds the documented archive URL and parses the recorded all-index file', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    const out = await fetchCloseForDate(nseNifty50Adapter, '2024-03-06', http, {});
    expect(out).toEqual({ kind: 'ok', point: { date: '2024-03-06', close: 22339.05 } });
    expect(get.mock.calls[0][0]).toBe('https://nsearchives.nseindia.com/content/indices/ind_close_all_06032024.csv');
  });
  it('BSE adapter has NO default endpoint: not_configured, and no request', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: BSE_FILE }));
    const out = await fetchCloseForDate(bseSensexAdapter, '2024-03-06', http, {});
    expect(out.kind).toBe('not_configured');
    expect(get).not.toHaveBeenCalled();
    expect(bseSensexAdapter.urlFor('2024-03-06', { MARKET_INDEX_BSE_CSV_URL_TEMPLATE: 'http://insecure.test/{DDMMYYYY}' })).toBeNull();
  });
  it('BSE adapter with an operator-supplied https template parses the recorded archive layout', async () => {
    const { http } = httpDouble(() => ({ status: 200, bodyText: BSE_FILE }));
    const out = await fetchCloseForDate(bseSensexAdapter, '2024-03-06', http, { MARKET_INDEX_BSE_CSV_URL_TEMPLATE: 'https://example.test/{YYYY-MM-DD}.csv' });
    expect(out).toEqual({ kind: 'ok', point: { date: '2024-03-06', close: 73502.64 } });
  });
  it('a file that has no row for the requested date is "no data" (holiday / not yet published), not an error', async () => {
    const { http } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    expect((await fetchCloseForDate(nseNifty50Adapter, '2024-03-07', http, {})).kind).toBe('no_data_for_date');
  });
  it('recentWeekdays skips weekends and returns newest first', () => {
    expect(recentWeekdays('2024-03-11', 3)).toEqual(['2024-03-11', '2024-03-08', '2024-03-07']);
  });
});

describe('polite, never bypasses bot protection', () => {
  it.each([403, 429, 401])('HTTP %i is SOURCE_BLOCKED: exactly ONE request, no retry, the run stops', async (status) => {
    const { http, get } = httpDouble(() => ({ status, bodyText: 'Access Denied' }));
    const db = fakeSupabase(tables());
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: ENV_ON, nowIso: NOW });
    expect(r.status).toBe('blocked');
    expect(get).toHaveBeenCalledTimes(1); // no retry, no second index, no second date
    expect(r.alerts.map((a) => a.code)).toContain('SOURCE_BLOCKED');
    expect(db.rpcCalls).toHaveLength(0);
    // The failure is recorded for backoff.
    expect(db.updates.some((u) => u.table === 'ii_reference_job_control' && (u.values.consecutive_failures as number) === 1)).toBe(true);
  });
  it('an HTML interstitial / CAPTCHA page served with 200 is treated as blocked, not parsed', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: '<html><title>Just a moment... captcha</title></html>' }));
    const r = await runMarketIndexDailyUpdate({ supabase: fakeSupabase(tables()).client, http, env: ENV_ON, nowIso: NOW });
    expect(r.status).toBe('blocked');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('server errors are retried a bounded number of times (3 attempts), nothing more', async () => {
    const { http, get, sleep } = httpDouble(() => ({ status: 503, bodyText: 'unavailable' }));
    const out = await fetchCloseForDate(nseNifty50Adapter, '2024-03-06', http, {});
    expect(out.kind).toBe('failed');
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalled();
  });
  it('sends only an identifying User-Agent and Accept: no cookies, no browser impersonation headers', async () => {
    const { http, get } = httpDouble(() => ({ status: 200, bodyText: NSE_FILE }));
    await fetchCloseForDate(nseNifty50Adapter, '2024-03-06', http, {});
    const headers = get.mock.calls[0][1];
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'User-Agent']);
    expect(headers['User-Agent']).toBe(FEED_USER_AGENT);
    expect(FEED_USER_AGENT).toMatch(/FHIP-IndexUpdater/);
    expect(FEED_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/i);
  });
  it('rate limit: a pause of at least RATE_LIMIT_MS separates consecutive requests', async () => {
    const { http, get, sleep } = httpDouble(() => ({ status: 404, bodyText: '' }));
    await runMarketIndexDailyUpdate({ supabase: fakeSupabase(tables()).client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(get.mock.calls.length).toBeGreaterThan(1);
    const rateSleeps = sleep.mock.calls.filter((c) => c[0] === RATE_LIMIT_MS).length;
    expect(rateSleeps).toBe(get.mock.calls.length - 1);
    expect(RATE_LIMIT_MS).toBeGreaterThanOrEqual(2000);
  });
  it('the real transport neither follows redirects nor sends credentials (static)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/services/investment-intelligence/marketIndex/dailyFeed.ts'), 'utf8');
    expect(src).toMatch(/redirect: 'manual'/);
    expect(src).toMatch(/credentials: 'omit'/);
  });
});

describe('a normal run', () => {
  it('fetches the missing recent weekdays, writes through the feed RPC, and a holiday (404) is not an error', async () => {
    const { http, get } = httpDouble((url) => {
      if (url.includes('06032024')) return { status: 200, bodyText: NSE_FILE };
      return { status: 404, bodyText: '' };
    });
    const db = fakeSupabase(tables(), { rpc: (_n, args) => ({ data: { inserted: (args.p_rows as unknown[]).length, identical: 0, conflicts_skipped: 0 }, error: null }) });
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(r.status).toBe('completed');
    expect(get.mock.calls.length).toBe(5); // 5 weekdays, Nifty only (BSE not configured -> no request)
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0].name).toBe('record_market_index_feed_closes');
    expect(db.rpcCalls[0].args).toMatchObject({ p_benchmark_key: 'IN_NIFTY_50_PRI', p_source_host: 'nsearchives.nseindia.com', p_rows: [{ date: '2024-03-06', close: 22339.05 }] });
    expect(r.perIndex.find((p) => p.indexKey === 'IN_SENSEX_PRI')!.outcome).toBe('not_configured');
    expect(r.alerts.map((a) => a.code)).toContain('FEED_NOT_CONFIGURED');
    expect(db.updates.some((u) => u.table === 'ii_reference_job_control' && u.values.consecutive_failures === 0)).toBe(true);
  });
  it('days already published are not fetched again (one row per trading day)', async () => {
    const { http, get } = httpDouble(() => ({ status: 404, bodyText: '' }));
    const have = recentWeekdays('2024-03-06', 5).map((d) => ({ benchmark_id: 'b-n', series_date: d, value: 22000, quality_status: 'ok' }));
    const db = fakeSupabase(tables({ ii_benchmark_series: have }));
    await runMarketIndexDailyUpdate({ supabase: db.client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(get).not.toHaveBeenCalled();
  });
  it('a value that spikes against the previous published close is rejected, alerted, and not written', async () => {
    const { http } = httpDouble((url) => (url.includes('06032024') ? { status: 200, bodyText: NSE_FILE } : { status: 404, bodyText: '' }));
    const db = fakeSupabase(tables({ ii_benchmark_series: [{ benchmark_id: 'b-n', series_date: '2024-02-28', value: 9000, quality_status: 'ok' }] }));
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(r.alerts.map((a) => a.code)).toContain('FEED_OUTLIER_REJECTED');
    expect(db.rpcCalls).toHaveLength(0);
  });
  it('a database-reported conflict (feed differs from a published value) raises FEED_VALUE_CONFLICT, nothing is overwritten', async () => {
    const { http } = httpDouble((url) => (url.includes('06032024') ? { status: 200, bodyText: NSE_FILE } : { status: 404, bodyText: '' }));
    const db = fakeSupabase(tables(), { rpc: () => ({ data: { inserted: 0, identical: 0, conflicts_skipped: 1 }, error: null }) });
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(r.alerts.map((a) => a.code)).toContain('FEED_VALUE_CONFLICT');
  });
});

describe('staleness alerting', () => {
  it('an index whose latest published close is older than the threshold raises a critical INDEX_STALE; never-loaded raises INDEX_NEVER_LOADED', async () => {
    const { http } = httpDouble(() => ({ status: 404, bodyText: '' }));
    const db = fakeSupabase(tables({ ii_benchmark_series: [{ benchmark_id: 'b-n', series_date: '2024-02-01', value: 21700, quality_status: 'ok' }] }));
    const r = await runMarketIndexDailyUpdate({ supabase: db.client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    const byCode = Object.fromEntries(r.alerts.map((a) => [a.code, a.severity]));
    expect(byCode.INDEX_STALE).toBe('critical');
    expect(byCode.INDEX_NEVER_LOADED).toBe('warning'); // Sensex has no rows at all
  });
  it('a fresh index raises no staleness alert', async () => {
    const { http } = httpDouble(() => ({ status: 404, bodyText: '' }));
    const rows = recentWeekdays('2024-03-06', 5).flatMap((d) => [{ benchmark_id: 'b-n', series_date: d, value: 22000, quality_status: 'ok' }, { benchmark_id: 'b-s', series_date: d, value: 73000, quality_status: 'ok' }]);
    const r = await runMarketIndexDailyUpdate({ supabase: fakeSupabase(tables({ ii_benchmark_series: rows })).client, http, env: { MARKET_INDEX_FEED_ENABLED: 'true' }, nowIso: NOW });
    expect(r.alerts.filter((a) => a.code.startsWith('INDEX_'))).toEqual([]);
  });
});
