// Factsheet benchmark reader: polite fetching, offline (a fake transport records every request; nothing touches the network).
// Named negative controls: robots.txt is honoured (a disallowed path makes NO document request) . no source off the
// official-domain allow-list is requested . a block is never retried or bypassed . an oversized document is skipped, not
// truncated . one request at a time with a per-host delay . no retry storm.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPoliteFetcher, parseRobots, robotsAllows, type FactsheetHttp, type FactsheetHttpRequest, type FactsheetHttpResponse } from '@/lib/services/investment-intelligence/factsheetReader/politeFetch';
import { FACTSHEET_USER_AGENT } from '@/lib/services/investment-intelligence/factsheetReader/types';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const HTML = new TextEncoder().encode('<html><body>Access denied</body></html>');
const DOC_URL = 'https://files.hdfcfund.com/s3fs-public/SID/x.pdf';

interface Logged {
  url: string;
  req: FactsheetHttpRequest;
}
type Handler = (url: string, req: FactsheetHttpRequest) => Partial<FactsheetHttpResponse>;

function fakeHttp(routes: Record<string, Handler | Partial<FactsheetHttpResponse>>) {
  const log: Logged[] = [];
  const http: FactsheetHttp = {
    async get(url, req) {
      log.push({ url, req });
      const r = routes[url];
      const out = typeof r === 'function' ? r(url, req) : (r ?? { status: 404, body: null });
      return { status: 200, headers: {}, body: null, tooLarge: false, contentLength: null, ...out };
    },
  };
  return { http, log };
}
function fetcherWith(routes: Record<string, Handler | Partial<FactsheetHttpResponse>>, config: Record<string, number> = {}) {
  const f = fakeHttp(routes);
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetcher = createPoliteFetcher({
    http: f.http,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: () => (clock += 5),
    config,
  });
  return { ...f, fetcher, sleeps };
}
const ROBOTS_OK = { status: 200, body: new TextEncoder().encode('User-agent: *\nDisallow: /private/\n'), headers: { 'content-type': 'text/plain' } };
const robots = (host: string, r: Partial<FactsheetHttpResponse> = ROBOTS_OK) => ({ [`https://${host}/robots.txt`]: r });

describe('robots.txt parsing (RFC 9309 semantics)', () => {
  it('uses the product-token group when present, else "*"; longest match wins; Allow wins a tie; empty Disallow allows all; * and $ wildcards', () => {
    const txt = ['User-agent: *', 'Disallow: /docs/', 'Allow: /docs/public/', '', 'User-agent: FHIP-FactsheetReader', 'Disallow: /secret/', 'Disallow: /*.zip$', 'Allow: /secret/open/', '', 'User-agent: other', 'Disallow: /'].join('\n');
    const mine = parseRobots(txt);
    expect(robotsAllows(mine, '/docs/a.pdf')).toBe(true); // the "*" group does not apply: a specific group exists
    expect(robotsAllows(mine, '/secret/a.pdf')).toBe(false);
    expect(robotsAllows(mine, '/secret/open/a.pdf')).toBe(true);
    expect(robotsAllows(mine, '/files/a.zip')).toBe(false);
    expect(robotsAllows(mine, '/files/a.zip?x=1')).toBe(true);
    const star = parseRobots(txt, 'Somebody-Else');
    expect(robotsAllows(star, '/docs/a.pdf')).toBe(false);
    expect(robotsAllows(star, '/docs/public/a.pdf')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/anything')).toBe(false);
  });
});

describe('manners', () => {
  it('NEGATIVE CONTROL: robots.txt disallowing the path means NO document request is made', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com', { status: 200, body: new TextEncoder().encode('User-agent: *\nDisallow: /s3fs-public/\n') }), [DOC_URL]: { status: 200, body: PDF } });
    const r = await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
    expect(r.kind).toBe('robots_disallowed');
    expect(t.log.map((l) => l.url)).toEqual(['https://files.hdfcfund.com/robots.txt']);
  });
  it('robots.txt is read once per host per run, not once per document', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, body: PDF }, 'https://files.hdfcfund.com/s3fs-public/SID/y.pdf': { status: 200, body: PDF } });
    await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
    await t.fetcher.fetchDocument('https://files.hdfcfund.com/s3fs-public/SID/y.pdf', { expectPdf: true });
    expect(t.log.filter((l) => l.url.endsWith('/robots.txt'))).toHaveLength(1);
  });
  it('a missing robots.txt (404) allows; an unreadable one (5xx, an HTML block page, 403) means "fetch nothing from this host this run"', async () => {
    const ok404 = fetcherWith({ ...robots('files.hdfcfund.com', { status: 404 }), [DOC_URL]: { status: 200, body: PDF } });
    expect((await ok404.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('ok');
    for (const bad of [{ status: 503 }, { status: 403 }, { status: 200, body: HTML }]) {
      const t = fetcherWith({ ...robots('files.hdfcfund.com', bad), [DOC_URL]: { status: 200, body: PDF } });
      const r = await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
      expect(r.kind, JSON.stringify(bad.status)).toBe('failed');
      expect(t.log.some((l) => l.url === DOC_URL)).toBe(false);
    }
  });
  it('every request carries the descriptive User-Agent (robots.txt included), no cookies, and a PDF Accept header', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, body: PDF } });
    await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
    expect(t.log).toHaveLength(2);
    for (const l of t.log) {
      expect(l.req.headers['User-Agent']).toBe(FACTSHEET_USER_AGENT);
      expect(Object.keys(l.req.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    }
    expect(FACTSHEET_USER_AGENT).toMatch(/^FHIP-FactsheetReader\/1\.0 \(\+https:\/\/app\.financialhealthplatform\.com;/);
    expect(t.log[1].req.headers.Accept).toMatch(/application\/pdf/);
  });
  it('conditional requests: validators are sent on the document request, and 304 is "not modified" (no body read)', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 304 } });
    const r = await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true, etag: '"abc"', lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT' });
    expect(r.kind).toBe('not_modified');
    const doc = t.log.find((l) => l.url === DOC_URL);
    expect(doc?.req.headers['If-None-Match']).toBe('"abc"');
    expect(doc?.req.headers['If-Modified-Since']).toBe('Wed, 01 Oct 2026 00:00:00 GMT');
    const robotsReq = t.log.find((l) => l.url.endsWith('/robots.txt'));
    expect(robotsReq?.req.headers['If-None-Match']).toBeUndefined();
  });
  it('one request at a time, with a pause between two requests to the SAME host and none for the first or for another host', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), ...robots('www.sbimf.com'), [DOC_URL]: { status: 200, body: PDF }, 'https://files.hdfcfund.com/b.pdf': { status: 200, body: PDF }, 'https://www.sbimf.com/c.pdf': { status: 200, body: PDF } }, { perHostDelayMs: 3000 });
    await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
    const afterFirst = t.sleeps.length;
    await t.fetcher.fetchDocument('https://files.hdfcfund.com/b.pdf', { expectPdf: true });
    expect(t.sleeps.length).toBeGreaterThan(afterFirst);
    expect(Math.max(...t.sleeps)).toBeGreaterThanOrEqual(2900);
    const sleepsBeforeOtherHost = t.sleeps.length;
    await t.fetcher.fetchDocument('https://www.sbimf.com/c.pdf', { expectPdf: true });
    // robots.txt for the new host and its document are the first requests to that host: no pause between them is for another host's sake
    expect(t.sleeps.length).toBeGreaterThanOrEqual(sleepsBeforeOtherHost);
    expect(t.sleeps[0] ?? 0).toBeGreaterThanOrEqual(0);
    expect(t.log.length).toBe(t.fetcher.requestCount);
  });
});

describe('allow-list and size', () => {
  it('NEGATIVE CONTROL: an address off the official-domain allow-list (or plain http, or with credentials) is refused with ZERO requests', async () => {
    const t = fetcherWith({});
    for (const url of ['https://evil.example.com/x.pdf', 'http://files.hdfcfund.com/x.pdf', 'https://user:pw@files.hdfcfund.com/x.pdf', 'https://hdfcfund.com.evil.example/x.pdf']) {
      expect((await t.fetcher.fetchDocument(url, { expectPdf: true })).kind, url).toBe('refused');
    }
    expect(t.log).toHaveLength(0);
  });
  it('NEGATIVE CONTROL: an oversized document is reported "too large" (Content-Length, or a body that overruns the cap) and its bytes are never returned', async () => {
    const byHeader = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, contentLength: 50_000_000, body: null } }, { maxDocumentBytes: 15 * 1024 * 1024 });
    expect(await byHeader.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).toEqual({ kind: 'too_large', contentLength: 50_000_000 });
    const byStream = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, tooLarge: true, body: null } });
    expect((await byStream.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('too_large');
    const byBody = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, body: new Uint8Array(2000) } }, { maxDocumentBytes: 1000 });
    expect((await byBody.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('too_large');
    // the request itself carries the cap so the real transport can abandon the download
    expect(byHeader.log.find((l) => l.url === DOC_URL)?.req.maxBytes).toBe(15 * 1024 * 1024);
  });
});

describe('blocks are respected, never bypassed', () => {
  it('NEGATIVE CONTROL: 403 / 429 is "blocked", is NOT retried, and the host is not contacted again in this run', async () => {
    for (const status of [403, 429, 401]) {
      const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status }, 'https://files.hdfcfund.com/other.pdf': { status: 200, body: PDF } });
      const r = await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
      expect(r).toMatchObject({ kind: 'blocked', status });
      expect(t.log.filter((l) => l.url === DOC_URL)).toHaveLength(1); // no retry storm
      const again = await t.fetcher.fetchDocument('https://files.hdfcfund.com/other.pdf', { expectPdf: true });
      expect(again.kind).toBe('blocked');
      expect(t.log.some((l) => l.url.endsWith('other.pdf'))).toBe(false);
      expect(t.fetcher.blockedHosts.has('files.hdfcfund.com')).toBe(true);
    }
  });
  it('an HTML page where a PDF was expected is an interstitial: blocked, not parsed', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 200, body: HTML } });
    expect((await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('blocked');
  });
  it('a 5xx or a missing document is a failure recorded once (the next run may try again); exactly ONE document request is made', async () => {
    for (const status of [500, 503, 404]) {
      const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status } });
      expect((await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('failed');
      expect(t.log.filter((l) => l.url === DOC_URL)).toHaveLength(1);
    }
  });
  it('a transport exception (timeout) is a failure, not a throw, and is not retried', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    const r = await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true });
    expect(r).toMatchObject({ kind: 'failed' });
    expect(t.log.filter((l) => l.url === DOC_URL)).toHaveLength(1);
  });
});

describe('redirects stay on the official domains and are re-checked against robots', () => {
  it('follows a redirect to another allow-listed host (robots for it is read too); refuses one to an unlisted host; stops after the cap', async () => {
    const ok = fetcherWith({
      ...robots('files.hdfcfund.com'),
      ...robots('www.sbimf.com'),
      [DOC_URL]: { status: 302, headers: { location: 'https://www.sbimf.com/moved.pdf' } },
      'https://www.sbimf.com/moved.pdf': { status: 200, body: PDF },
    });
    expect((await ok.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('ok');
    expect(ok.log.map((l) => l.url)).toContain('https://www.sbimf.com/robots.txt');

    const off = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 301, headers: { location: 'https://evil.example.com/x.pdf' } } });
    expect((await off.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('refused');
    expect(off.log.some((l) => l.url.includes('evil.example.com'))).toBe(false);

    const loop = fetcherWith({ ...robots('files.hdfcfund.com'), [DOC_URL]: { status: 302, headers: { location: DOC_URL } } }, { maxRedirects: 3 });
    expect((await loop.fetcher.fetchDocument(DOC_URL, { expectPdf: true })).kind).toBe('failed');
    expect(loop.log.filter((l) => l.url === DOC_URL).length).toBeLessThanOrEqual(4);
  });
  it('the conditional validators are sent only on the first hop', async () => {
    const t = fetcherWith({ ...robots('files.hdfcfund.com'), ...robots('www.sbimf.com'), [DOC_URL]: { status: 302, headers: { location: 'https://www.sbimf.com/m.pdf' } }, 'https://www.sbimf.com/m.pdf': { status: 200, body: PDF } });
    await t.fetcher.fetchDocument(DOC_URL, { expectPdf: true, etag: '"x"' });
    expect(t.log.find((l) => l.url === 'https://www.sbimf.com/m.pdf')?.req.headers['If-None-Match']).toBeUndefined();
  });
});

describe('the real transport (static)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'lib/services/investment-intelligence/factsheetReader/politeFetch.ts'), 'utf8');
  it('never follows redirects itself, sends no credentials, does not cache, aborts on a timer and abandons an over-cap body', () => {
    expect(src).toMatch(/redirect: 'manual'/);
    expect(src).toMatch(/credentials: 'omit'/);
    expect(src).toMatch(/cache: 'no-store'/);
    expect(src).toMatch(/AbortController/);
    expect(src).toMatch(/reader\.cancel/);
    const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join(' ');
    expect(code).not.toMatch(/['"]cookie['"]|set-cookie|puppeteer|playwright|headless|captcha/i);
  });
});
