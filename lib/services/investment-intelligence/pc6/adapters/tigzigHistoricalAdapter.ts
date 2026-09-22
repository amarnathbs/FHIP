// PC6/NAV 1.15 — TIGZIG historical adapter.
//
// Qualification evidence (this session, 2026-09-21, re-run fresh per the
// workbook's own instruction not to trust a prior review's claim):
//
//   GET https://api.tigzig.com/mf/v1/nav?scheme=119551&since=2026-09-14&to=2026-09-18
//   -> 200 OK, real data: 4 observations (15/16/17/18 Sep 2026), scheme_name
//      "Aditya Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW",
//      ISIN INF209KA12Z1. Consistent with the workbook's own prior-recorded
//      result (a small live 200 response for the same scheme/window).
//
// CAVEAT — this is NOT a production-runtime qualification. The request
// above was issued from this session's own tool sandbox (a generic
// internet-connected fetcher), not from FHIP's actual Vercel/Amplify/
// Supabase-edge network path, and did not carry FHIP's own User-Agent. A
// network egress rule, IP allowlist, or WAF that only affects the real
// runtime would not show up here. NAV 1.18 must re-run this same request
// from the deployed environment before TIGZIG is called qualified for
// production use.
//
// Contract discovered live (base URL differs from the workbook's own listed
// documentation page https://www.tigzig.com/apis/mf-nav, which is a docs
// page, not the API host):
//   Base:   https://api.tigzig.com/mf/v1
//   Path:   GET /nav?scheme={amfiCodeOrIsin}&since={yyyy-mm-dd}&to={yyyy-mm-dd}
//   Auth:   none documented, none required
//   Shape:  { scheme_code, scheme_name, isin, isin2, first_available_date,
//             latest_available_date, count, data: [{ date, nav }] }
//   Rate limit: 300 req/min per IP (standard), 429 with Retry-After above that.
//   Licence: compilation schema CC0 1.0; underlying data is AMFI's public
//            record; TIGZIG explicitly disclaims being an authoritative
//            source ("not affiliated with, endorsed by, or sponsored by
//            AMFI... check against AMFI for anything that matters"). This is
//            exactly why FHIP treats TIGZIG output as CANDIDATE data only —
//            AMFI's own NAVHistoryReport remains the authoritative
//            cross-check, never bypassed by this adapter.
//
// This adapter returns `coverage: 'unknown'` rather than 'complete' even on
// a clean 200 response: TIGZIG's own docs do not document a pagination
// contract for large windows, and `count` alone does not prove every
// business day in [fromDate, toDate] was returned (a scheme with a
// suspended NAV, or a source-side gap, would look identical to "the window
// is fully covered"). Coverage completeness is validated downstream against
// AMFI, never asserted here.

import { fetchWithRetry } from '../httpFetchWithRetry';
import type {
  HistoricalNavAdapter,
  HistoricalNavAdapterResult,
  HistoricalNavRequest,
} from './historicalNavAdapter';

export const TIGZIG_ADAPTER_VERSION = '2026-09-21.1';
const TIGZIG_BASE_URL = 'https://api.tigzig.com/mf/v1/nav';

interface TigzigResponseShape {
  scheme_code: number | string;
  scheme_name?: string | null;
  isin?: string | null;
  first_available_date?: string | null;
  latest_available_date?: string | null;
  count: number;
  data: Array<{ date: string; nav: number }>;
}

function isTigzigResponseShape(value: unknown): value is TigzigResponseShape {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    ('scheme_code' in v) &&
    typeof v.count === 'number' &&
    Array.isArray(v.data) &&
    v.data.every((d) => typeof d === 'object' && d !== null && 'date' in (d as object) && 'nav' in (d as object))
  );
}

async function sha256Hex(text: string): Promise<string> {
  // Web Crypto is available in both the Next.js edge/node runtime and
  // vitest's node environment; avoids a Node-only 'crypto' import here so
  // this adapter stays runtime-neutral like the rest of PC6's fetch layer.
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class TigzigHistoricalAdapter implements HistoricalNavAdapter {
  readonly providerKey = 'tigzig';
  readonly adapterVersion = TIGZIG_ADAPTER_VERSION;

  async fetchHistory(request: HistoricalNavRequest): Promise<HistoricalNavAdapterResult> {
    const retrievedAt = new Date().toISOString();
    const url = `${TIGZIG_BASE_URL}?scheme=${encodeURIComponent(request.schemeIdentifier)}&since=${request.fromDate}&to=${request.toDate}`;

    const result = await fetchWithRetry(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0 (NAV1 selective historical adapter)' } });

    if (!result.ok) {
      const last = result.failures[result.failures.length - 1] ?? 'unknown failure';
      const rateLimited = result.failures.some((f) => f.includes('HTTP 429'));
      return {
        ok: false,
        schemeIdentifier: request.schemeIdentifier,
        kind: rateLimited ? 'rate_limited' : 'http_error',
        detail: `TIGZIG request failed after ${result.attemptsMade} attempt(s): ${last}`,
        provider: { key: this.providerKey, adapterVersion: this.adapterVersion, requestUrl: url, httpStatus: null, retrievedAt },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value!.bodyText);
    } catch (e) {
      return {
        ok: false,
        schemeIdentifier: request.schemeIdentifier,
        kind: 'schema_unexpected',
        detail: `TIGZIG response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        provider: { key: this.providerKey, adapterVersion: this.adapterVersion, requestUrl: url, httpStatus: result.value!.status, retrievedAt },
      };
    }

    if (!isTigzigResponseShape(parsed)) {
      return {
        ok: false,
        schemeIdentifier: request.schemeIdentifier,
        kind: 'schema_unexpected',
        detail: 'TIGZIG response did not match the documented {scheme_code, count, data:[{date,nav}]} shape — schema may have changed since 2026-09-21 qualification.',
        provider: { key: this.providerKey, adapterVersion: this.adapterVersion, requestUrl: url, httpStatus: result.value!.status, retrievedAt },
      };
    }

    if (parsed.count === 0 || parsed.data.length === 0) {
      return {
        ok: false,
        schemeIdentifier: request.schemeIdentifier,
        kind: 'not_found',
        detail: `TIGZIG returned zero observations for ${request.schemeIdentifier} in [${request.fromDate}, ${request.toDate}].`,
        provider: { key: this.providerKey, adapterVersion: this.adapterVersion, requestUrl: url, httpStatus: result.value!.status, retrievedAt },
      };
    }

    return {
      ok: true,
      schemeIdentifier: request.schemeIdentifier,
      providerSchemeName: parsed.scheme_name ?? null,
      observations: parsed.data.map((d) => ({ date: d.date, nav: String(d.nav) })),
      coverage: 'unknown', // see module header — never asserted 'complete' from count alone
      provider: {
        key: this.providerKey,
        adapterVersion: this.adapterVersion,
        requestUrl: url,
        httpStatus: result.value!.status,
        retrievedAt,
        rawResponseChecksum: await sha256Hex(result.value!.bodyText),
      },
    };
  }
}
