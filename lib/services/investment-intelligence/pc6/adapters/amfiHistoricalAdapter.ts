// NAV 1 Stage D (D.3) — AMFI as the PRIMARY historical NAV source for
// on-demand hydration. TIGZIG is the fallback (see fallbackHistoricalAdapter.ts).
// PO decision, 2026-09-24.
//
// WHY AMFI. It is the canonical publisher. On 2026-09-24 its NAV History
// Report backfilled 21-23 Sep in production and matched an independent AMFI
// master on 450 of 450 sampled values. TIGZIG is a third party that had not
// been qualified for production.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. Hydration asks for ONE scheme's
// history, but AMFI's history endpoint has no scheme filter -- only a date
// window, returning the whole market (~1.2 MB per day). It DOES accept a
// fund-house filter, `mf=<code>`, measured live on 2026-09-24:
//
//   1 day, whole market ......... 1.19 MB   8,730 schemes
//   1 day, one fund house ....... 0.05 MB     347 schemes
//   90 days, one fund house ..... 2.66 MB, 1.6 s
//   365 days, one fund house .... 10.6 MB, 6.2 s
//
// So each request is filtered to the scheme's fund house and the one scheme is
// picked out. Requests are capped at AMFI_MAX_REQUEST_DAYS (~5 MB each) so no
// single response approaches the compute execution limit that cut a larger
// request short the same day.
//
// RESOLVING A SCHEME'S FUND HOUSE, FROM AMFI ITSELF. Probing each fund-house
// code for one full business day tells us which schemes belong to it. Measured
// 2026-09-24: 53 codes carry data (highest 89) and together cover exactly the
// 8,730 schemes the whole market published that day -- a complete map in ~7 s
// with 8 requests in flight. It is cached per process for a day. No manually
// maintained mapping table.
//
// A scheme that published nothing on the reference day (matured, merged,
// suspended, or brand new) cannot be resolved. That is reported as not_found,
// which is exactly the case the TIGZIG fallback exists for.

import { buildUrl, getReferenceSource } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { parseNavHistory } from '../amfiParser';
import { fetchWithRetry } from '../httpFetchWithRetry';
import type {
  HistoricalNavAdapter,
  HistoricalNavAdapterResult,
  HistoricalNavObservation,
  HistoricalNavRequest,
} from './historicalNavAdapter';

export const AMFI_HISTORICAL_ADAPTER_VERSION = 'amfi-history-adapter-v1';
export const AMFI_HISTORY_SOURCE_ID = 'amfi_nav_history';
/** Largest single AMFI request, in days. 365 days for one fund house measured 10.6 MB; 180 keeps each near 5 MB. */
export const AMFI_MAX_REQUEST_DAYS = 180;
/** Fund-house codes are probed 1..this. 53 codes carried data on 2026-09-24, highest 89; headroom for new houses. */
export const AMFI_MAX_FUND_HOUSE_CODE = 150;
/** A reference day must carry at least this many schemes, so a weekend or holiday (a few hundred liquid funds) is never used. */
export const AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY = 5000;
const FUND_HOUSE_MAP_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_CONCURRENCY = 8;
const USER_AGENT = 'FHIP-PC6/1.0 (NAV1 selective historical adapter; AMFI primary)';

/** Resolves an AMFI scheme code to its fund-house (`mf`) code, or null if AMFI does not currently publish it. */
export type FundHouseResolver = (schemeCode: string) => Promise<number | null>;

export interface AmfiHistoricalAdapterOptions {
  /** Injected in tests. Defaults to the probe-and-cache resolver below. */
  resolveFundHouse?: FundHouseResolver;
  /** Injected in tests. Defaults to the real clock. ISO yyyy-mm-dd. */
  today?: () => string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Splits [fromDate, toDate] into consecutive windows of at most maxDays, oldest first. */
export function splitAmfiWindow(fromDate: string, toDate: string, maxDays: number = AMFI_MAX_REQUEST_DAYS) {
  const windows: { fromDate: string; toDate: string }[] = [];
  let start = fromDate;
  while (start <= toDate) {
    const end = addDays(start, maxDays - 1);
    windows.push({ fromDate: start, toDate: end < toDate ? end : toDate });
    start = addDays(end, 1);
  }
  return windows;
}

function fundHouseUrl(fromDate: string, toDate: string, mf: number): string {
  // buildUrl enforces the registry's `enabled` flag -- a disabled source throws
  // before any network call.
  return `${buildUrl(AMFI_HISTORY_SOURCE_ID, { fromDate, toDate })}&mf=${mf}`;
}

function schemeCodesIn(bodyText: string): string[] {
  const codes: string[] = [];
  for (const line of bodyText.split(/\r?\n/)) {
    const m = /^(\d+);/.exec(line);
    if (m) codes.push(m[1]);
  }
  return codes;
}

let cachedMap: { builtAt: number; referenceDate: string; map: Map<string, number> } | null = null;

/** Test hook: forget the cached fund-house map. */
export function resetAmfiFundHouseCache(): void {
  cachedMap = null;
}

/**
 * Builds the scheme-code -> fund-house-code map by probing every code for one
 * full business day. Walks back from yesterday until it finds a day on which
 * the market published at least AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY schemes.
 */
export async function buildAmfiFundHouseMap(today: string): Promise<{ referenceDate: string; map: Map<string, number> }> {
  for (let back = 1; back <= 10; back++) {
    const day = addDays(today, -back);
    const map = new Map<string, number>();
    const codes = Array.from({ length: AMFI_MAX_FUND_HOUSE_CODE }, (_, i) => i + 1);
    const worker = async () => {
      for (let mf = codes.shift(); mf !== undefined; mf = codes.shift()) {
        const res = await fetchWithRetry(fundHouseUrl(day, day, mf), { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) throw new Error(`AMFI fund-house probe mf=${mf} failed: ${res.failures.at(-1) ?? 'unknown'}`);
        for (const code of schemeCodesIn(res.value!.bodyText)) map.set(code, mf);
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    if (map.size >= AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY) return { referenceDate: day, map };
  }
  throw new Error(`no business day in the last 10 carried ${AMFI_MIN_SCHEMES_FOR_REFERENCE_DAY}+ AMFI schemes -- cannot build the fund-house map`);
}

function defaultResolver(today: () => string): FundHouseResolver {
  return async (schemeCode) => {
    if (!cachedMap || Date.now() - cachedMap.builtAt > FUND_HOUSE_MAP_TTL_MS) {
      const built = await buildAmfiFundHouseMap(today());
      cachedMap = { builtAt: Date.now(), ...built };
    }
    return cachedMap.map.get(schemeCode) ?? null;
  };
}

export class AmfiHistoricalAdapter implements HistoricalNavAdapter {
  readonly providerKey = 'amfi';
  readonly adapterVersion = AMFI_HISTORICAL_ADAPTER_VERSION;
  private readonly resolveFundHouse: FundHouseResolver;
  private readonly today: () => string;

  constructor(options: AmfiHistoricalAdapterOptions = {}) {
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10));
    this.resolveFundHouse = options.resolveFundHouse ?? defaultResolver(this.today);
  }

  async fetchHistory(request: HistoricalNavRequest): Promise<HistoricalNavAdapterResult> {
    const retrievedAt = new Date().toISOString();
    const fail = (
      kind: 'network' | 'http_error' | 'not_found' | 'rate_limited' | 'schema_unexpected' | 'disabled',
      detail: string,
      requestUrl: string | null = null,
      httpStatus: number | null = null,
    ): HistoricalNavAdapterResult => ({
      ok: false,
      schemeIdentifier: request.schemeIdentifier,
      kind,
      detail,
      provider: { key: this.providerKey, adapterVersion: this.adapterVersion, requestUrl, httpStatus, retrievedAt },
    });

    if (!getReferenceSource(AMFI_HISTORY_SOURCE_ID).enabled) {
      return fail('disabled', `registry source '${AMFI_HISTORY_SOURCE_ID}' is disabled`);
    }

    let mf: number | null;
    try {
      mf = await this.resolveFundHouse(request.schemeIdentifier);
    } catch (e) {
      return fail('network', `could not resolve the AMFI fund house: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (mf === null) {
      return fail('not_found', `AMFI does not currently publish scheme ${request.schemeIdentifier}, so its fund house cannot be resolved (matured, merged, suspended or new) -- a fallback source is needed`);
    }

    const byDate = new Map<string, string>();
    const bodyChecksums: string[] = [];
    let providerSchemeName: string | null = null;
    let lastUrl = '';
    let lastStatus = 0;

    for (const window of splitAmfiWindow(request.fromDate, request.toDate)) {
      const url = fundHouseUrl(window.fromDate, window.toDate, mf);
      const res = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        const rateLimited = res.failures.some((f) => f.includes('HTTP 429'));
        return fail(rateLimited ? 'rate_limited' : 'http_error',
          `AMFI request failed after ${res.attemptsMade} attempt(s): ${res.failures.at(-1) ?? 'unknown failure'}`, url);
      }
      lastUrl = url;
      lastStatus = res.value!.status;

      let parsed;
      try {
        parsed = parseNavHistory(new TextEncoder().encode(res.value!.bodyText), { asOfDate: this.today() });
      } catch (e) {
        return fail('schema_unexpected', `AMFI history response did not parse: ${e instanceof Error ? e.message : String(e)}`, url, lastStatus);
      }
      for (const r of parsed.records) {
        if (r.amfiSchemeCode !== request.schemeIdentifier) continue;
        byDate.set(r.navDate, r.navRaw.trim());
        providerSchemeName ??= r.schemeName;
      }
      bodyChecksums.push(await sha256Hex(res.value!.bodyText));
    }

    if (byDate.size === 0) {
      return fail('not_found', `AMFI fund house ${mf} returned no NAV for scheme ${request.schemeIdentifier} in [${request.fromDate}, ${request.toDate}]`, lastUrl || null, lastStatus || null);
    }

    const observations: HistoricalNavObservation[] = [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, nav]) => ({ date, nav }));

    return {
      ok: true,
      schemeIdentifier: request.schemeIdentifier,
      providerSchemeName,
      observations,
      // A missing date may be a holiday or a scheme that did not publish; the
      // adapter cannot tell which, so it never claims 'complete'.
      coverage: 'unknown',
      provider: {
        key: this.providerKey,
        adapterVersion: this.adapterVersion,
        requestUrl: lastUrl,
        httpStatus: lastStatus,
        retrievedAt,
        rawResponseChecksum: await sha256Hex(bodyChecksums.join('|')),
      },
    };
  }
}
