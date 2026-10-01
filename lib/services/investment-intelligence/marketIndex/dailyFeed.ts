// Daily market-index updater: fetches the latest closing value of the Nifty 50
// and the BSE Sensex and records one row per trading day.
//
// ===========================================================================
// SHIPS DISABLED, FAILS CLOSED, AND MUST STAY DISABLED UNTIL THE PO CONFIRMS
// NSE/BSE TERMS. NSE and BSE restrict automated scraping and redistribution of
// their index data. This module exists so that, once the Product Owner has
// confirmed the terms (or holds a licence) and enabled it, the plumbing is
// ready — it is NOT permission to scrape anything.
// ===========================================================================
//
// TWO independent switches must BOTH be on, and both ship off:
//   1. the environment variable MARKET_INDEX_FEED_ENABLED === 'true'
//   2. ii_reference_job_control row 'market_index_daily_close' enabled = true
// A missing control row, a read error, or any other value is "off" (fail closed).
// When off, NO network request is made and nothing is read or written beyond
// the control row.
//
// RULES THE RUNNER ENFORCES (and the tests prove):
//   * Only documented/public download endpoints. The NSE adapter points at
//     NSE's public daily index-closing archive file; the BSE adapter has NO
//     default endpoint — it needs an explicit URL template supplied by the
//     operator after the terms are confirmed (MARKET_INDEX_BSE_CSV_URL_TEMPLATE),
//     and reports 'not_configured' otherwise.
//   * A polite, identifying User-Agent; no cookies; no spoofed browser headers.
//   * A minimum gap between requests (RATE_LIMIT_MS).
//   * NEVER bypasses bot protection. A 401/403/429, a CAPTCHA/interstitial or
//     an HTML body where CSV was expected is recorded as SOURCE_BLOCKED and the
//     run STOPS — no retry, no alternate route, no header tricks. Only network
//     errors, timeouts and 5xx are retried (bounded, with backoff).
//   * Values are validated like an upload (positive, plausible band, no spike
//     against the previous published close); a value that would CHANGE a
//     published close is never written (the database function counts it as a
//     skipped conflict).
//   * Staleness is alerted (assessFreshness) using the repo's existing Alert
//     shape, the same one the PC6 ingest job returns and logs.
//
// Adapters sit behind IndexFeedAdapter so a licensed vendor feed can replace
// them without touching the runner.
import type { SupabaseClient } from '@supabase/supabase-js';
import { MARKET_INDEX_DAILY_JOB_KEY, MARKET_INDEX_FEED_ENV_FLAG, MARKET_INDEX_KEYS, MARKET_INDEX_STALE_AFTER_DAYS, type MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import { parseIndexCsv, OUTLIER_REJECT_FRACTION } from './indexCsvParser';
import { withRetry, looksLikeBlockPage } from '@/lib/services/investment-intelligence/pc6/httpFetchWithRetry';
import { decideStart, nextAttemptAfter, type JobControlRow } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import { assessFreshness } from '@/lib/services/investment-intelligence/pc6/referenceDataQuality';
import type { Alert } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';

export const FEED_RUNNER_VERSION = 'market-index-feed-v1';
export const FEED_USER_AGENT = 'FHIP-IndexUpdater/1.0 (+https://app.financialhealthplatform.com; operator-approved daily close fetch)';
export const RATE_LIMIT_MS = 2500;
/** How many recent weekdays the runner looks back over to fill missed days. */
export const LOOKBACK_WEEKDAYS = 5;

export interface IndexClosePoint {
  date: string;
  close: number;
}

export type AdapterFetchOutcome =
  | { kind: 'ok'; point: IndexClosePoint }
  | { kind: 'no_data_for_date' } // 404 / file absent: a non-trading day or not yet published
  | { kind: 'not_configured'; detail: string }
  | { kind: 'blocked'; detail: string } // bot protection / forbidden / interstitial — STOP, never route around
  | { kind: 'failed'; detail: string }; // network/5xx after bounded retries

export interface FeedHttp {
  /** One GET. Must not follow challenges or attach cookies. */
  get(url: string, headers: Record<string, string>): Promise<{ status: number; bodyText: string }>;
  sleep(ms: number): Promise<void>;
}

export interface IndexFeedAdapter {
  id: string;
  indexKey: MarketIndexKey;
  /** Host recorded in the ledger (never a full URL, never a credential). */
  sourceHost: string;
  /** The URL for one trading date, or null when no documented endpoint is configured. */
  urlFor(dateIso: string, env: Record<string, string | undefined>): string | null;
  /** Parse the response body into the close for `dateIso`, or null when the body has no usable row for it. */
  parse(bodyText: string, dateIso: string): IndexClosePoint | null;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;

function parseFor(indexKey: MarketIndexKey, body: string, dateIso: string): IndexClosePoint | null {
  const a = parseIndexCsv(body, indexKey, dateIso);
  const row = [...a.accepted, ...a.weekendHeldBack].find((r) => r.date === dateIso);
  return row ? { date: row.date, close: row.close } : null;
}

/** NSE's public daily index-closing archive file (one CSV for all indices, per trading date). */
export const nseNifty50Adapter: IndexFeedAdapter = {
  id: 'nse_ind_close_all',
  indexKey: MARKET_INDEX_KEYS.NIFTY_50,
  sourceHost: 'nsearchives.nseindia.com',
  urlFor: (dateIso) => `https://nsearchives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy(dateIso)}.csv`,
  parse: (body, dateIso) => parseFor(MARKET_INDEX_KEYS.NIFTY_50, body, dateIso),
};

/**
 * BSE: NO default endpoint. BSE publishes index history through its own
 * archive pages whose automated use is restricted; the operator must supply a
 * permitted URL template containing {DDMMYYYY} or {YYYY-MM-DD}.
 */
export const bseSensexAdapter: IndexFeedAdapter = {
  id: 'bse_sensex_configured_csv',
  indexKey: MARKET_INDEX_KEYS.SENSEX,
  sourceHost: 'operator-configured',
  urlFor: (dateIso, env) => {
    const template = env.MARKET_INDEX_BSE_CSV_URL_TEMPLATE;
    if (!template || !/^https:\/\//.test(template)) return null;
    return template.replace('{DDMMYYYY}', ddmmyyyy(dateIso)).replace('{YYYY-MM-DD}', dateIso);
  },
  parse: (body, dateIso) => parseFor(MARKET_INDEX_KEYS.SENSEX, body, dateIso),
};

export const DEFAULT_ADAPTERS: readonly IndexFeedAdapter[] = [nseNifty50Adapter, bseSensexAdapter];

/** One adapter, one date. Bounded retry ONLY for transport failures and 5xx. */
export async function fetchCloseForDate(adapter: IndexFeedAdapter, dateIso: string, http: FeedHttp, env: Record<string, string | undefined>): Promise<AdapterFetchOutcome> {
  const url = adapter.urlFor(dateIso, env);
  if (!url) return { kind: 'not_configured', detail: `${adapter.id}: no documented public endpoint is configured; the operator must supply one after NSE/BSE terms are confirmed.` };
  type Attempt = { status: number; bodyText: string };
  const result = await withRetry<Attempt>(
    async () => {
      const res = await http.get(url, { 'User-Agent': FEED_USER_AGENT, Accept: 'text/csv,text/plain;q=0.9' });
      if (res.status >= 500) return { retryable: true, reason: `HTTP ${res.status}` };
      return { retryable: false, value: res };
    },
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10_000, sleep: http.sleep }
  );
  if (!result.ok || !result.value) return { kind: 'failed', detail: `${adapter.id}: ${result.failures.join('; ')}` };
  const { status, bodyText } = result.value;
  if (status === 401 || status === 403 || status === 429) return { kind: 'blocked', detail: `${adapter.id}: HTTP ${status} - the source refused automated access. The updater stops here and does not retry or route around it.` };
  if (status === 404) return { kind: 'no_data_for_date' };
  if (status < 200 || status >= 300) return { kind: 'failed', detail: `${adapter.id}: HTTP ${status}` };
  if (looksLikeBlockPage(bodyText)) return { kind: 'blocked', detail: `${adapter.id}: an HTML page was returned where a CSV was expected (bot-protection or interstitial). The updater stops here and does not try to bypass it.` };
  const point = adapter.parse(bodyText, dateIso);
  return point ? { kind: 'ok', point } : { kind: 'no_data_for_date' };
}

/** The last N weekdays up to and including `todayIso`, newest first. Pure. */
export function recentWeekdays(todayIso: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${todayIso}T00:00:00.000Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export type FeedRunStatus = 'disabled_env' | 'skipped_kill_switch' | 'skipped_backoff' | 'completed' | 'blocked' | 'failed';

export interface FeedRunResult {
  runnerVersion: typeof FEED_RUNNER_VERSION;
  status: FeedRunStatus;
  detail: string;
  perIndex: Array<{ indexKey: MarketIndexKey; adapter: string; fetched: number; inserted: number; identical: number; conflictsSkipped: number; rejected: number; outcome: string }>;
  alerts: Alert[];
  requestsMade: number;
}

export interface FeedDeps {
  supabase: SupabaseClient; // service-role client (server-side only)
  http: FeedHttp;
  env: Record<string, string | undefined>;
  nowIso: string; // full ISO timestamp
  adapters?: readonly IndexFeedAdapter[];
}

async function readControl(supabase: SupabaseClient): Promise<JobControlRow | null> {
  const { data, error } = await supabase
    .from('ii_reference_job_control')
    .select('job_key, enabled, disabled_reason, consecutive_failures, next_attempt_not_before, last_success_at')
    .eq('job_key', MARKET_INDEX_DAILY_JOB_KEY)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as { job_key: string; enabled: boolean; disabled_reason: string | null; consecutive_failures: number; next_attempt_not_before: string | null; last_success_at: string | null };
  return { jobKey: r.job_key, enabled: r.enabled, disabledReason: r.disabled_reason, consecutiveFailures: r.consecutive_failures, nextAttemptNotBefore: r.next_attempt_not_before, lastSuccessAt: r.last_success_at };
}

async function recordOutcome(supabase: SupabaseClient, control: JobControlRow, success: boolean, nowIso: string): Promise<void> {
  const failures = success ? 0 : control.consecutiveFailures + 1;
  await supabase
    .from('ii_reference_job_control')
    .update(success ? { consecutive_failures: 0, last_success_at: nowIso, next_attempt_not_before: null, updated_at: nowIso } : { consecutive_failures: failures, last_failure_at: nowIso, next_attempt_not_before: nextAttemptAfter(nowIso, failures), updated_at: nowIso })
    .eq('job_key', MARKET_INDEX_DAILY_JOB_KEY);
}

async function latestPublished(supabase: SupabaseClient, indexKey: MarketIndexKey): Promise<IndexClosePoint | null> {
  const { data: bench } = await supabase.from('ii_benchmarks').select('id').eq('benchmark_key', indexKey).maybeSingle();
  if (!bench) return null;
  const { data } = await supabase.from('ii_benchmark_series').select('series_date, value').eq('benchmark_id', (bench as { id: string }).id).neq('quality_status', 'superseded').order('series_date', { ascending: false }).limit(1).maybeSingle();
  return data ? { date: (data as { series_date: string }).series_date, close: Number((data as { value: number | string }).value) } : null;
}

async function publishedDates(supabase: SupabaseClient, indexKey: MarketIndexKey, from: string): Promise<Set<string>> {
  const { data: bench } = await supabase.from('ii_benchmarks').select('id').eq('benchmark_key', indexKey).maybeSingle();
  if (!bench) return new Set();
  const { data } = await supabase.from('ii_benchmark_series').select('series_date').eq('benchmark_id', (bench as { id: string }).id).gte('series_date', from);
  return new Set(((data ?? []) as Array<{ series_date: string }>).map((r) => r.series_date));
}

export async function runMarketIndexDailyUpdate(deps: FeedDeps): Promise<FeedRunResult> {
  const base = { runnerVersion: FEED_RUNNER_VERSION, perIndex: [] as FeedRunResult['perIndex'], alerts: [] as Alert[], requestsMade: 0 };

  // Switch 1: the environment. Off (or anything but the literal 'true') means
  // NOTHING happens — not even a database read.
  if (deps.env[MARKET_INDEX_FEED_ENV_FLAG] !== 'true') {
    return { ...base, status: 'disabled_env', detail: `${MARKET_INDEX_FEED_ENV_FLAG} is not 'true'. The daily market-index feed is OFF by default and must stay off until NSE/BSE terms are confirmed.` };
  }
  // Switch 2: the database kill switch (fails closed on a missing row).
  const control = await readControl(deps.supabase);
  const decision = decideStart(control, MARKET_INDEX_DAILY_JOB_KEY, deps.nowIso);
  if (!decision.start || !control) {
    return { ...base, status: decision.start ? 'skipped_kill_switch' : decision.status, detail: decision.start ? 'No job-control row.' : decision.detail };
  }

  const today = deps.nowIso.slice(0, 10);
  const dates = recentWeekdays(today, LOOKBACK_WEEKDAYS);
  const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
  let blocked = false;
  let anyFailure = false;
  let requests = 0;

  for (const adapter of adapters) {
    const summary = { indexKey: adapter.indexKey, adapter: adapter.id, fetched: 0, inserted: 0, identical: 0, conflictsSkipped: 0, rejected: 0, outcome: 'ok' };
    base.perIndex.push(summary);
    if (blocked) {
      summary.outcome = 'skipped_after_block';
      continue;
    }
    const have = await publishedDates(deps.supabase, adapter.indexKey, dates[dates.length - 1]);
    const prev = await latestPublished(deps.supabase, adapter.indexKey);
    const missing = dates.filter((d) => !have.has(d)).reverse(); // oldest first
    const collected: IndexClosePoint[] = [];
    for (const d of missing) {
      // Rate limit: pause only between REAL requests (an unconfigured adapter makes none).
      const willRequest = adapter.urlFor(d, deps.env) !== null;
      if (willRequest && requests > 0) await deps.http.sleep(RATE_LIMIT_MS);
      if (willRequest) requests += 1;
      const out = await fetchCloseForDate(adapter, d, deps.http, deps.env);
      if (out.kind === 'ok') {
        summary.fetched += 1;
        // Same plausibility rule as an upload: no spike against the last published close.
        const ref = collected[collected.length - 1] ?? prev;
        if (ref && Math.abs(out.point.close / ref.close - 1) > OUTLIER_REJECT_FRACTION) {
          summary.rejected += 1;
          base.alerts.push({ severity: 'critical', code: 'FEED_OUTLIER_REJECTED', detail: `${adapter.id}: ${out.point.date} close differs by more than ${OUTLIER_REJECT_FRACTION * 100}% from the previous close and was not written.` });
        } else collected.push(out.point);
      } else if (out.kind === 'blocked') {
        blocked = true;
        anyFailure = true;
        summary.outcome = 'blocked';
        base.alerts.push({ severity: 'critical', code: 'SOURCE_BLOCKED', detail: out.detail });
        break;
      } else if (out.kind === 'not_configured') {
        summary.outcome = 'not_configured';
        base.alerts.push({ severity: 'info', code: 'FEED_NOT_CONFIGURED', detail: out.detail });
        break;
      } else if (out.kind === 'failed') {
        anyFailure = true;
        summary.outcome = 'failed';
        base.alerts.push({ severity: 'warning', code: 'SOURCE_OUTAGE', detail: out.detail });
        break;
      }
      // no_data_for_date: a holiday or not yet published - not an error.
    }
    if (collected.length > 0) {
      const { data, error } = await deps.supabase.rpc('record_market_index_feed_closes', {
        p_benchmark_key: adapter.indexKey,
        p_rows: collected.map((p) => ({ date: p.date, close: p.close })),
        p_source_host: adapter.sourceHost,
      });
      if (error) {
        anyFailure = true;
        summary.outcome = 'write_failed';
        base.alerts.push({ severity: 'critical', code: 'FEED_WRITE_FAILED', detail: `${adapter.id}: the database refused the write.` });
      } else {
        const d = data as { inserted: number; identical: number; conflicts_skipped: number };
        summary.inserted = d.inserted;
        summary.identical = d.identical;
        summary.conflictsSkipped = d.conflicts_skipped;
        if (d.conflicts_skipped > 0) base.alerts.push({ severity: 'warning', code: 'FEED_VALUE_CONFLICT', detail: `${adapter.id}: ${d.conflicts_skipped} published value(s) differ from the feed and were left unchanged for review.` });
      }
    }
    // Staleness: judged on what is published AFTER this run, per index.
    const after = await latestPublished(deps.supabase, adapter.indexKey);
    const fresh = assessFreshness(after?.date ?? null, today, MARKET_INDEX_STALE_AFTER_DAYS);
    if (fresh.state !== 'fresh') base.alerts.push({ severity: fresh.state === 'never_ingested' ? 'warning' : 'critical', code: fresh.state === 'never_ingested' ? 'INDEX_NEVER_LOADED' : 'INDEX_STALE', detail: `${adapter.indexKey}: ${fresh.detail}` });
  }

  await recordOutcome(deps.supabase, control, !anyFailure, deps.nowIso);
  const status: FeedRunStatus = blocked ? 'blocked' : anyFailure ? 'failed' : 'completed';
  return { ...base, status, detail: status === 'completed' ? 'Run finished.' : 'Run finished with a source or write problem; see alerts.', requestsMade: requests };
}

/** The real transport: a single GET with no cookies, no redirects to other hosts followed blindly, 30 s timeout. */
export function realFeedHttp(): FeedHttp {
  return {
    async get(url, headers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'manual', credentials: 'omit' });
        return { status: res.status, bodyText: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
