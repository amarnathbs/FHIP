// NAV2 Stage 2 -- the polite RBI fetcher for the weekly risk-free refresh.
//
// RBI publishes no explicit reuse licence; the Product Owner accepted that risk (03-10-2026) on condition that the read is
// polite, small and honest. Everything below enforces RISK_FREE_REFRESH_FETCH_POLICY (lib/engines/nav2/riskFreeRefreshGate.ts)
// in code, and the tests prove each rule:
//
//   * ONE host (www.rbi.org.in, https only); a redirect is not followed (it is an error), a different host is refused;
//   * a descriptive User-Agent on every request; Accept: text/html;
//   * AT MOST `maxRequestsPerRun` page requests per run (plus one robots.txt request), and at least `minSpacingMs` between any two;
//   * robots.txt is read first and honoured (a disallowed path is never requested; an unreadable robots.txt stops the run);
//   * HTML only: a PDF, an Excel file or any other content type is refused, and so is any URL that names one;
//   * a response larger than `maxResponseBytes` is refused (streamed and cut, never buffered whole);
//   * a per-request timeout and a whole-run deadline;
//   * a human-verification / CAPTCHA page is a hard stop with its own error: it is NEVER solved, retried or worked around;
//   * conditional requests (If-None-Match / If-Modified-Since) are supported when the caller supplies validators.
//
// Nothing here parses a page (rbiHtml.ts does) and nothing here writes to a database.

import { RISK_FREE_REFRESH_FETCH_POLICY as POLICY } from '@/lib/engines/nav2/riskFreeRefreshGate';

export const RBI_HOST = 'www.rbi.org.in';
export const RBI_ORIGIN = `https://${RBI_HOST}`;

export type RbiFetchErrorCode = 'blocked_host' | 'blocked_file_type' | 'robots_disallowed' | 'robots_unavailable' | 'budget_exhausted' | 'deadline' | 'human_verification' | 'not_html' | 'too_large' | 'http_error' | 'redirect' | 'timeout' | 'network';

export class RbiFetchError extends Error {
  constructor(readonly code: RbiFetchErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'RbiFetchError';
  }
}

export interface FetchedPage {
  status: 200 | 304;
  url: string;
  /** null for a 304 (not modified). */
  html: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface FetcherDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
}

export const liveFetcherDeps: FetcherDeps = {
  fetchImpl: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowMs: () => Date.now(),
};

const HUMAN_VERIFICATION = /g-recaptcha|h-captcha|hcaptcha|cf-challenge|captcha|verify (?:that )?you are (?:a )?human|human verification|are you a robot|access denied/i;
const FORBIDDEN_FILE = /\.(pdf|xlsx?|docx?|zip)(\?|#|$)/i;

/** The robots.txt rule: for the `User-agent: *` group (and any group naming our token), the longest matching Allow / Disallow wins; Allow wins a tie. */
export function robotsAllows(robotsTxt: string, path: string, agentToken = 'fhip-riskfreerefresh'): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const applicable = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (r.path === '') continue; // "Disallow:" with no value allows everything
      const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      if (new RegExp(`^${pattern}`).test(path)) {
        const len = r.path.length;
        if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
      }
    }
  }
  return best ? best.allow : true;
}

export class PoliteRbiFetcher {
  private pageRequests = 0;
  private robotsRequests = 0;
  private lastRequestAt: number | null = null;
  private startedAt: number | null = null;
  private robotsTxt: string | null = null;

  constructor(private readonly deps: FetcherDeps = liveFetcherDeps, private readonly policy = POLICY) {}

  get pageRequestsMade(): number {
    return this.pageRequests;
  }
  get robotsRequestsMade(): number {
    return this.robotsRequests;
  }

  private checkUrl(url: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RbiFetchError('blocked_host', 'The address is not a valid URL.');
    }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== RBI_HOST) throw new RbiFetchError('blocked_host', `Only https://${RBI_HOST} may be requested.`);
    if (FORBIDDEN_FILE.test(u.pathname + u.search)) throw new RbiFetchError('blocked_file_type', 'Documents (PDF, Excel and similar) are never requested; only HTML pages are read.');
    return u;
  }

  private async pace(): Promise<void> {
    const now = this.deps.nowMs();
    if (this.startedAt === null) this.startedAt = now;
    if (now - this.startedAt > this.policy.runDeadlineMs) throw new RbiFetchError('deadline', 'The run exceeded its time limit.');
    if (this.lastRequestAt !== null) {
      const wait = this.policy.minSpacingMs - (now - this.lastRequestAt);
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastRequestAt = this.deps.nowMs();
    if (this.lastRequestAt - this.startedAt > this.policy.runDeadlineMs) throw new RbiFetchError('deadline', 'The run exceeded its time limit.');
  }

  private async request(u: URL, init: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string> }, asText: boolean): Promise<{ status: number; text: string | null; etag: string | null; lastModified: string | null; contentType: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.policy.perRequestTimeoutMs);
    try {
      const res = await this.deps.fetchImpl(u.toString(), {
        method: init.method,
        body: init.body,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': this.policy.userAgent, Accept: asText ? 'text/html,text/plain;q=0.8' : 'text/html', ...(init.headers ?? {}) },
      });
      if (res.status === 304) return { status: 304, text: null, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), contentType: '' };
      if (res.status >= 300 && res.status < 400) throw new RbiFetchError('redirect', `The server redirected (${res.status}); redirects are not followed.`, res.status);
      if (res.status === 403 || res.status === 429) throw new RbiFetchError('human_verification', `The server answered ${res.status}; the run stops and does not try to get round it.`, res.status);
      if (!res.ok) throw new RbiFetchError('http_error', `The server answered ${res.status}.`, res.status);
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (asText ? !/text\/(html|plain)/.test(contentType) : !contentType.includes('text/html')) throw new RbiFetchError('not_html', `The response is ${contentType || 'of an unknown type'}, not an HTML page.`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.policy.maxResponseBytes) throw new RbiFetchError('too_large', 'The page is larger than the allowed size.');
      const text = await this.readCapped(res);
      return { status: res.status, text, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), contentType };
    } catch (e) {
      if (e instanceof RbiFetchError) throw e;
      if ((e as { name?: string })?.name === 'AbortError') throw new RbiFetchError('timeout', 'The request timed out.');
      throw new RbiFetchError('network', 'The request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCapped(res: Response): Promise<string> {
    const cap = this.policy.maxResponseBytes;
    if (!res.body) {
      const t = await res.text();
      if (Buffer.byteLength(t, 'utf8') > cap) throw new RbiFetchError('too_large', 'The page is larger than the allowed size.');
      return t;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new RbiFetchError('too_large', 'The page is larger than the allowed size.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  /** Reads robots.txt once per run (one request, outside the page budget). A 404 means "no rules"; any other failure stops the run. */
  async ensureRobots(): Promise<void> {
    if (this.robotsTxt !== null) return;
    if (this.robotsRequests >= 1) throw new RbiFetchError('robots_unavailable', 'robots.txt could not be read.');
    this.robotsRequests += 1;
    await this.pace();
    try {
      const r = await this.request(this.checkUrl(`${RBI_ORIGIN}/robots.txt`), { method: 'GET' }, true);
      this.robotsTxt = r.text ?? '';
    } catch (e) {
      if (e instanceof RbiFetchError && e.status === 404) {
        this.robotsTxt = '';
        return;
      }
      throw new RbiFetchError('robots_unavailable', 'robots.txt could not be read, so nothing is requested.');
    }
  }

  private async page(url: string, init: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string> }): Promise<FetchedPage> {
    const u = this.checkUrl(url);
    await this.ensureRobots();
    if (!robotsAllows(this.robotsTxt ?? '', u.pathname + u.search)) throw new RbiFetchError('robots_disallowed', 'robots.txt does not allow this page.');
    if (this.pageRequests >= this.policy.maxRequestsPerRun) throw new RbiFetchError('budget_exhausted', `At most ${this.policy.maxRequestsPerRun} pages are requested per run.`);
    this.pageRequests += 1;
    await this.pace();
    const r = await this.request(u, init, false);
    if (r.status === 304) return { status: 304, url: u.toString(), html: null, etag: r.etag, lastModified: r.lastModified };
    if (HUMAN_VERIFICATION.test((r.text ?? '').slice(0, 20000)) && !/Treasury Bills|Press Releases|Week Ended/i.test(r.text ?? '')) {
      throw new RbiFetchError('human_verification', 'The page asks for human verification; the run stops and does not try to get round it.');
    }
    return { status: 200, url: u.toString(), html: r.text, etag: r.etag, lastModified: r.lastModified };
  }

  get(url: string, validators: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchedPage> {
    const headers: Record<string, string> = {};
    if (this.policy.conditionalRequests && validators.etag) headers['If-None-Match'] = validators.etag;
    if (this.policy.conditionalRequests && validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
    return this.page(url, { method: 'GET', headers });
  }

  post(url: string, form: Record<string, string>): Promise<FetchedPage> {
    return this.page(url, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  }
}
