// Polite fetching of ONE registered document at a time. The only module here that touches the network, and only
// through the injected FactsheetHttp (tests inject a fake; the real transport is realFactsheetHttp below).
//
// MANNERS (each is enforced here and tested):
//   * A descriptive User-Agent that names the product and where it comes from. No spoofed browser headers, no cookies.
//   * robots.txt is read once per host per run and HONOURED (RFC 9309 semantics: the product-token group, else '*';
//     longest match wins; Allow wins a tie). A robots file that cannot be read (5xx / network / HTML block page /
//     401 / 403) means "do not fetch from this host this run", never "assume allowed".
//   * ONE request at a time, and at least perHostDelayMs between two requests to the same host.
//   * Conditional requests (If-None-Match / If-Modified-Since) when the previous read left validators.
//   * Hard caps: bytes (Content-Length is checked first; a body that overruns the cap is abandoned and the
//     document is reported 'too large', never truncated) and time (an abort timer per request).
//   * No retry storm: ONE attempt per document per run; a failure is retried only by a later run.
//   * Never bypasses a block: 401 / 403 / 429 or an HTML interstitial where a PDF was expected is 'blocked' and
//     the host is not contacted again in this run. No login, no cookies, no CAPTCHA handling, no alternative route.
//   * Only the exact registered URL is requested (plus robots.txt, plus redirects to another allow-listed
//     official host, each re-checked against robots). No listing pages are crawled.

import { FACTSHEET_DEFAULTS, FACTSHEET_ROBOTS_PRODUCT_TOKEN, FACTSHEET_USER_AGENT } from './types';
import { hostOf, isAllowedHost } from './sourceRegistry';

export interface FactsheetHttpRequest {
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
}

export interface FactsheetHttpResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** null when the body was not read (304, or too large). */
  body: Uint8Array | null;
  tooLarge: boolean;
  contentLength: number | null;
}

export interface FactsheetHttp {
  /** ONE GET. Must not follow redirects, send cookies, or retry. */
  get(url: string, req: FactsheetHttpRequest): Promise<FactsheetHttpResponse>;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, productToken: string = FACTSHEET_ROBOTS_PRODUCT_TOKEN): RobotsRules {
  interface Group {
    agents: string[];
    allow: string[];
    disallow: string[];
  }
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!cur) continue;
      if (value === '') continue; // an empty Disallow allows everything
      (key === 'allow' ? cur.allow : cur.disallow).push(value);
    } else {
      lastWasAgent = false;
    }
  }
  const token = productToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

function ruleMatches(rule: string, pathAndQuery: string): boolean {
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(pathAndQuery);
}

/** Longest matching rule wins; on a tie Allow wins; no match = allowed. */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const r of rules.allow) if (ruleMatches(r, pathAndQuery)) bestAllow = Math.max(bestAllow, r.length);
  for (const r of rules.disallow) if (ruleMatches(r, pathAndQuery)) bestDisallow = Math.max(bestDisallow, r.length);
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export type FetchOutcome =
  | { kind: 'ok'; status: number; bytes: Uint8Array; contentType: string | null; etag: string | null; lastModified: string | null }
  | { kind: 'not_modified' }
  | { kind: 'too_large'; contentLength: number | null }
  | { kind: 'blocked'; status: number | null; detail: string }
  | { kind: 'robots_disallowed'; detail: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'failed'; status: number | null; detail: string };

export interface PoliteFetcherDeps {
  http: FactsheetHttp;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in ms, injectable for tests. */
  nowMs: () => number;
  config?: Partial<{ maxDocumentBytes: number; requestTimeoutMs: number; perHostDelayMs: number; maxRedirects: number }>;
}

export interface FetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  /** The registered document is a PDF: an HTML answer is then a block page / interstitial, not the document. */
  expectPdf: boolean;
}

const ROBOTS_MAX_BYTES = 512 * 1024;

export interface PoliteFetcher {
  fetchDocument(url: string, opts: FetchOptions): Promise<FetchOutcome>;
  /** Hosts that answered with a block in this run (for the run report). */
  readonly blockedHosts: ReadonlySet<string>;
  /** Number of HTTP requests made (robots.txt included). */
  readonly requestCount: number;
}

const looksHtml = (b: Uint8Array) => /^\s*</.test(Buffer.from(b.subarray(0, 64)).toString('utf8'));

export function createPoliteFetcher(deps: PoliteFetcherDeps): PoliteFetcher {
  const cfg = { ...FACTSHEET_DEFAULTS, ...deps.config };
  const robots = new Map<string, RobotsRules | 'unavailable'>();
  const lastRequestAt = new Map<string, number>();
  const blocked = new Set<string>();
  let requests = 0;

  async function pace(host: string): Promise<void> {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + cfg.perHostDelayMs - deps.nowMs();
      if (wait > 0) await deps.sleep(wait);
    }
  }

  async function request(url: string, host: string, headers: Record<string, string>, maxBytes: number): Promise<FactsheetHttpResponse> {
    await pace(host);
    requests += 1;
    try {
      return await deps.http.get(url, { headers: { 'User-Agent': FACTSHEET_USER_AGENT, ...headers }, maxBytes, timeoutMs: cfg.requestTimeoutMs });
    } finally {
      lastRequestAt.set(host, deps.nowMs());
    }
  }

  async function rulesFor(host: string): Promise<RobotsRules | 'unavailable'> {
    const cached = robots.get(host);
    if (cached) return cached;
    let result: RobotsRules | 'unavailable';
    try {
      const res = await request(`https://${host}/robots.txt`, host, { Accept: 'text/plain' }, ROBOTS_MAX_BYTES);
      if (res.status === 404 || res.status === 410) result = { allow: [], disallow: [] };
      else if (res.status === 200 && res.body && !res.tooLarge && !looksHtml(res.body)) result = parseRobots(Buffer.from(res.body).toString('utf8'));
      else result = 'unavailable'; // 401/403/5xx/HTML/too large: do not assume anything is allowed
    } catch {
      result = 'unavailable';
    }
    robots.set(host, result);
    return result;
  }

  async function fetchDocument(url: string, opts: FetchOptions): Promise<FetchOutcome> {
    let current = url;
    for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
      const host = hostOf(current);
      if (!host || !isAllowedHost(host)) return { kind: 'refused', detail: 'The address is not on the official-domain allow-list.' };
      if (blocked.has(host)) return { kind: 'blocked', status: null, detail: `${host} refused automated access earlier in this run; it is not contacted again.` };
      const rules = await rulesFor(host);
      if (rules === 'unavailable') return { kind: 'failed', status: null, detail: `${host}: robots.txt could not be read, so nothing is fetched from this host in this run.` };
      const u = new URL(current);
      if (!robotsAllows(rules, `${u.pathname}${u.search}`)) return { kind: 'robots_disallowed', detail: `${host}: robots.txt disallows this path for this reader.` };

      const headers: Record<string, string> = { Accept: opts.expectPdf ? 'application/pdf,*/*;q=0.1' : 'text/html,application/pdf;q=0.9,*/*;q=0.1' };
      if (hop === 0 && opts.etag) headers['If-None-Match'] = opts.etag;
      if (hop === 0 && opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

      let res: FactsheetHttpResponse;
      try {
        res = await request(current, host, headers, cfg.maxDocumentBytes);
      } catch (e) {
        return { kind: 'failed', status: null, detail: `${host}: ${e instanceof Error && e.name === 'AbortError' ? 'the request timed out' : 'the request failed'}.` };
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers['location'];
        if (!loc) return { kind: 'failed', status: res.status, detail: `${host}: a redirect without a target.` };
        try {
          current = new URL(loc, current).toString();
        } catch {
          return { kind: 'failed', status: res.status, detail: `${host}: an unusable redirect target.` };
        }
        continue;
      }
      if (res.status === 304) return { kind: 'not_modified' };
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        blocked.add(host);
        return { kind: 'blocked', status: res.status, detail: `${host}: HTTP ${res.status}. The source refused automated access; this reader stops here and does not retry or route around it.` };
      }
      if (res.status === 404 || res.status === 410) return { kind: 'failed', status: res.status, detail: `${host}: the registered document was not found (HTTP ${res.status}).` };
      if (res.status < 200 || res.status >= 300) return { kind: 'failed', status: res.status, detail: `${host}: HTTP ${res.status}.` };
      if (res.tooLarge || (res.contentLength !== null && res.contentLength > cfg.maxDocumentBytes)) return { kind: 'too_large', contentLength: res.contentLength };
      if (!res.body || res.body.length === 0) return { kind: 'failed', status: res.status, detail: `${host}: an empty answer.` };
      if (res.body.length > cfg.maxDocumentBytes) return { kind: 'too_large', contentLength: res.body.length };
      if (opts.expectPdf && looksHtml(res.body)) {
        blocked.add(host);
        return { kind: 'blocked', status: res.status, detail: `${host}: a web page came back where a PDF was expected (an interstitial or bot-protection page). This reader does not try to bypass it.` };
      }
      return { kind: 'ok', status: res.status, bytes: res.body, contentType: res.headers['content-type'] ?? null, etag: res.headers['etag'] ?? null, lastModified: res.headers['last-modified'] ?? null };
    }
    return { kind: 'failed', status: null, detail: 'Too many redirects.' };
  }

  return {
    fetchDocument,
    get blockedHosts() {
      return blocked;
    },
    get requestCount() {
      return requests;
    },
  };
}

// ---------------------------------------------------------------------------
// The real transport
// ---------------------------------------------------------------------------

/** One GET with a timeout, no cookies, no automatic redirects, and a streamed body that is abandoned past maxBytes. */
export function realFactsheetHttp(): FactsheetHttp {
  return {
    async get(url, req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', headers: req.headers, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const cl = Number(headers['content-length']);
        const contentLength = Number.isFinite(cl) && cl >= 0 && headers['content-length'] !== undefined ? cl : null;
        if (res.status === 304 || (res.status >= 300 && res.status < 400) || !res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, headers, body: null, tooLarge: false, contentLength };
        }
        if (contentLength !== null && contentLength > req.maxBytes) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, headers, body: null, tooLarge: true, contentLength };
        }
        const reader = res.body?.getReader();
        if (!reader) return { status: res.status, headers, body: new Uint8Array(0), tooLarge: false, contentLength };
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > req.maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { status: res.status, headers, body: null, tooLarge: true, contentLength };
          }
          chunks.push(value);
        }
        const body = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          body.set(c, off);
          off += c.length;
        }
        return { status: res.status, headers, body, tooLarge: false, contentLength };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
