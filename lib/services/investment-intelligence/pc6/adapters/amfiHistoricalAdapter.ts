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
// RESOLVING A SCHEME'S FUND HOUSE. The caller supplies the resolver, and on
// the server it reads the codes STORED in ii_amfi_fund_houses (migration
// 0191) through ii_scheme_master.amc_name -- so a hydration run sends AMFI no
// lookup requests at all.
//
// This adapter used to build that map itself by probing all 150 codes on
// every cold process, 8 at a time. AMFI appears to throttle that burst from
// the production server's address: the first real production run slowed to
// ~90 s per request after it, and the second (2026-09-24) stalled with
// nothing recorded. The probe is gone, and the resolver is now REQUIRED, so
// no caller can quietly fall back into it.
//
// A scheme the resolver cannot place is reported as not_found -- the case the
// TIGZIG fallback exists for.

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
/**
 * Per-request limits for AMFI: 45 s per attempt, 3 attempts -- so one bad
 * request costs at most ~2.3 minutes rather than hanging a run (the
 * failure that stalled the second production hydration run, 2026-09-24).
 */
export const AMFI_REQUEST_OPTIONS = { timeoutMs: 45_000, maxAttempts: 3 } as const;

/**
 * What an AMFI NAV-history response actually is. Observed live 2026-09-24:
 *   - a window with data  -> text/plain starting "Scheme Code;..."
 *   - a window with NONE  -> HTTP 200, text/html, ~8 KB, titled
 *     "View/Download NAV History" and saying "No data found on the basis of
 *     selected parameters for this report" (also returned for a fund-house
 *     code that does not exist)
 * Anything else -- a block page, an error or maintenance page -- is NOT an
 * answer. Before this, every HTML body parsed to zero rows and was reported
 * as "no data", so a block page could have been recorded as the start of a
 * fund's history (a wrong, permanent history floor).
 */
export type AmfiHistoryBodyKind = 'data' | 'no_data' | 'unrecognised';
export function classifyAmfiHistoryBody(body: string): AmfiHistoryBodyKind {
  const text = body.replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('Scheme Code;')) return 'data';
  if (/<title>\s*View\/Download NAV History\s*<\/title>/i.test(text)
    && /No data found on the basis of selected parameters/i.test(text)) return 'no_data';
  return 'unrecognised';
}
const USER_AGENT = 'FHIP-PC6/1.0 (NAV1 selective historical adapter; AMFI primary)';

/** Resolves an AMFI scheme code to its fund-house (`mf`) code, or null if AMFI does not currently publish it. */
export type FundHouseResolver = (schemeCode: string) => Promise<number | null>;

export interface AmfiHistoricalAdapterOptions {
  /** Injected in tests. Defaults to the probe-and-cache resolver below. */
  /** Required. On the server: the stored-codes resolver from selectiveHistoricalHydrationJobLive.ts. */
  resolveFundHouse: FundHouseResolver;
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

export class AmfiHistoricalAdapter implements HistoricalNavAdapter {
  readonly providerKey = 'amfi';
  readonly adapterVersion = AMFI_HISTORICAL_ADAPTER_VERSION;
  private readonly resolveFundHouse: FundHouseResolver;
  private readonly today: () => string;

  constructor(options: AmfiHistoricalAdapterOptions) {
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10));
    this.resolveFundHouse = options.resolveFundHouse;
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
      const res = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } }, AMFI_REQUEST_OPTIONS);
      if (!res.ok) {
        const rateLimited = res.failures.some((f) => f.includes('HTTP 429'));
        return fail(rateLimited ? 'rate_limited' : 'http_error',
          `AMFI request failed after ${res.attemptsMade} attempt(s): ${res.failures.at(-1) ?? 'unknown failure'}`, url);
      }
      lastUrl = url;
      lastStatus = res.value!.status;

      const bodyKind = classifyAmfiHistoryBody(res.value!.bodyText);
      if (bodyKind === 'unrecognised') {
        const start = res.value!.bodyText.replace(/\s+/g, ' ').trim().slice(0, 120);
        return fail('schema_unexpected',
          `AMFI returned something that is neither a NAV history file nor its "no data" page -- not treated as "no data" (starts: "${start}")`,
          url, lastStatus);
      }
      if (bodyKind === 'no_data') {
        bodyChecksums.push(await sha256Hex(res.value!.bodyText));
        continue; // AMFI's own answer: nothing for this fund house in this window
      }

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
