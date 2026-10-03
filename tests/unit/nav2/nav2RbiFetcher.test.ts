// NAV2 Stage 2 -- the polite RBI fetcher: every politeness rule is a test.
//
// Matrix: Stage 2 rows S2-28 (request budget, spacing, User-Agent, robots, HTML only, size cap, host lock) and S2-29 (a verification
// page is a hard stop).
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  the (budget+1)th page request is refused BEFORE any network call; robots.txt does not use the page budget;
//   NC-R2  spacing: with a clock that does not move, every request after the first waits at least minSpacingMs;
//   NC-R3  a disallowed path, a PDF URL, another host, http, a PDF content type, an oversized body and a redirect each fail with their own code;
//   NC-R4  a 403 / 429 and a CAPTCHA page stop the run (human_verification) and are NOT retried;
//   NC-R5  an unreadable robots.txt stops the run with NO page request; a 404 robots.txt means no rules.
import { describe, expect, it } from 'vitest';
import { RISK_FREE_REFRESH_FETCH_POLICY as POLICY } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { PoliteRbiFetcher, RbiFetchError, robotsAllows, type FetcherDeps } from '@/lib/services/investment-intelligence/nav2/rbiFetcher';
import { RBI_LISTING_URL, RBI_NSDP_URL } from '@/lib/services/investment-intelligence/nav2/rbiSource';

const html = (body = '<html><body>Press Releases list</body></html>', init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const robots = (txt = 'User-agent: *\nDisallow: /secret/\n') => new Response(txt, { status: 200, headers: { 'content-type': 'text/plain' } });

function setup(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deps: FetcherDeps = {
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return route(String(url), init);
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    nowMs: () => now,
  };
  return { fetcher: new PoliteRbiFetcher(deps), sleeps, calls, advance: (ms: number) => (now += ms) };
}
const ok = (u: string) => (u.endsWith('/robots.txt') ? robots() : html());

describe('politeness', () => {
  it('sends a descriptive User-Agent and HTML Accept on every request, robots.txt first', async () => {
    const { fetcher, calls } = setup(ok);
    await fetcher.get(RBI_LISTING_URL);
    expect(calls[0].url).toBe('https://www.rbi.org.in/robots.txt');
    expect(calls[1].url).toBe(RBI_LISTING_URL);
    for (const c of calls) {
      const h = c.init.headers as Record<string, string>;
      expect(h['User-Agent']).toBe(POLICY.userAgent);
      expect(h['User-Agent']).toMatch(/FHIP-RiskFreeRefresh/);
      expect(h.Accept).toMatch(/text\/(html|plain)/);
      expect(c.init.redirect).toBe('manual');
    }
  });

  it('NC-R2: waits at least minSpacingMs between any two requests (robots included) even when the clock does not move on its own', async () => {
    const { fetcher, sleeps } = setup(ok);
    await fetcher.get(RBI_LISTING_URL);
    await fetcher.get(RBI_NSDP_URL);
    expect(sleeps).toHaveLength(2); // robots -> page 1, page 1 -> page 2 (nothing before the very first request)
    for (const s of sleeps) expect(s).toBeGreaterThanOrEqual(POLICY.minSpacingMs);
  });

  it('does not sleep when enough real time has already passed', async () => {
    const { fetcher, sleeps, advance } = setup(ok);
    await fetcher.get(RBI_LISTING_URL);
    sleeps.length = 0;
    advance(POLICY.minSpacingMs + 1);
    await fetcher.get(RBI_NSDP_URL);
    expect(sleeps).toEqual([]);
  });

  it('NC-R1: the budget is a hard cap checked before the network; robots.txt is outside it', async () => {
    const { fetcher, calls } = setup(ok);
    for (let i = 0; i < POLICY.maxRequestsPerRun; i++) await fetcher.get(RBI_LISTING_URL);
    const before = calls.length;
    await expect(fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(calls.length).toBe(before);
    expect(fetcher.pageRequestsMade).toBe(POLICY.maxRequestsPerRun);
    expect(fetcher.robotsRequestsMade).toBe(1);
    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1); // read once per run
  });

  it('a whole-run deadline stops further requests', async () => {
    const { fetcher, advance } = setup(ok);
    await fetcher.get(RBI_LISTING_URL);
    advance(POLICY.runDeadlineMs + 1);
    await expect(fetcher.get(RBI_NSDP_URL)).rejects.toMatchObject({ code: 'deadline' });
  });

  it('supports conditional requests when validators are supplied, and reports a 304 without a body', async () => {
    const { fetcher, calls } = setup((u) => (u.endsWith('/robots.txt') ? robots() : new Response(null, { status: 304, headers: { etag: '"abc"' } })));
    const r = await fetcher.get(RBI_NSDP_URL, { etag: '"abc"', lastModified: 'Wed, 30 Sep 2026 10:00:00 GMT' });
    expect(r).toMatchObject({ status: 304, html: null, etag: '"abc"' });
    const h = calls[1].init.headers as Record<string, string>;
    expect(h['If-None-Match']).toBe('"abc"');
    expect(h['If-Modified-Since']).toBe('Wed, 30 Sep 2026 10:00:00 GMT');
  });
});

describe('what may be requested (NC-R3)', () => {
  const refuses = async (url: string, code: string) => {
    const { fetcher, calls } = setup(ok);
    await expect(fetcher.get(url)).rejects.toMatchObject({ code });
    expect(calls).toEqual([]); // refused before ANY request, robots included
  };
  it('another host, plain http, an invalid URL and a document URL are refused before any request', async () => {
    await refuses('https://rbidocs.rbi.org.in/rdocs/x.pdf', 'blocked_host');
    await refuses('https://example.com/x', 'blocked_host');
    await refuses('http://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4', 'blocked_host');
    await refuses('not a url', 'blocked_host');
    await refuses('https://www.rbi.org.in/rdocs/PressRelease/PDFs/PR1.PDF', 'blocked_file_type');
    await refuses('https://www.rbi.org.in/x/table.xlsx', 'blocked_file_type');
  });

  it('robots.txt: a disallowed path is never requested; Allow can carve an exception; the longest rule wins', async () => {
    const { fetcher, calls } = setup((u) => (u.endsWith('/robots.txt') ? robots('User-agent: *\nDisallow: /Scripts/\nAllow: /Scripts/BS_NSDPDisplay.aspx\n') : html()));
    await expect(fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(calls).toHaveLength(1); // only robots.txt
    expect((await fetcher.get(RBI_NSDP_URL)).status).toBe(200);
  });

  it('robotsAllows: groups, wildcards, end anchors, our own token, empty Disallow', () => {
    expect(robotsAllows('', '/x')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/x')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /a*b$\n', '/aXXb')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /a*b$\n', '/aXXbc')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: fhip-riskfreerefresh\nAllow: /\n', '/x')).toBe(true);
    expect(robotsAllows('User-agent: googlebot\nDisallow: /\n', '/x')).toBe(true);
  });

  it('NC-R5: a 404 robots.txt means no rules; any other robots failure stops the run with NO page request', async () => {
    const a = setup((u) => (u.endsWith('/robots.txt') ? new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }) : html()));
    expect((await a.fetcher.get(RBI_LISTING_URL)).status).toBe(200);
    for (const bad of [new Response('err', { status: 500, headers: { 'content-type': 'text/plain' } }), new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'application/pdf' } })]) {
      const b = setup((u) => (u.endsWith('/robots.txt') ? bad : html()));
      await expect(b.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'robots_unavailable' });
      expect(b.calls.filter((c) => !c.url.endsWith('/robots.txt'))).toEqual([]);
    }
  });

  it('only HTML: a PDF content type is refused; so is a body over the size cap (declared or streamed)', async () => {
    const pdf = setup((u) => (u.endsWith('/robots.txt') ? robots() : new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })));
    await expect(pdf.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'not_html' });
    const declared = setup((u) => (u.endsWith('/robots.txt') ? robots() : html('x', { headers: { 'content-type': 'text/html', 'content-length': String(POLICY.maxResponseBytes + 1) } })));
    await expect(declared.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'too_large' });
    const streamed = setup((u) => (u.endsWith('/robots.txt') ? robots() : html('x'.repeat(POLICY.maxResponseBytes + 10))));
    await expect(streamed.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('a redirect is an error, not followed; other HTTP errors and a timeout have their own codes', async () => {
    const r = setup((u) => (u.endsWith('/robots.txt') ? robots() : new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })));
    await expect(r.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'redirect' });
    expect(r.calls).toHaveLength(2);
    const e = setup((u) => (u.endsWith('/robots.txt') ? robots() : new Response('x', { status: 503, headers: { 'content-type': 'text/html' } })));
    await expect(e.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'http_error', status: 503 });
    const t = setup((u) => {
      if (u.endsWith('/robots.txt')) return robots();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(t.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('human verification is a hard stop (NC-R4, matrix 70)', () => {
  it('a 403 or 429 is human_verification and is requested exactly once (no retry)', async () => {
    for (const status of [403, 429]) {
      const s = setup((u) => (u.endsWith('/robots.txt') ? robots() : new Response('blocked', { status, headers: { 'content-type': 'text/html' } })));
      await expect(s.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'human_verification', status });
      expect(s.calls.filter((c) => !c.url.endsWith('/robots.txt'))).toHaveLength(1);
    }
  });
  it('a CAPTCHA page returned with a 200 is human_verification, unless the page is plainly the real content', async () => {
    const captcha = setup((u) => (u.endsWith('/robots.txt') ? robots() : html('<html><body><div class="g-recaptcha"></div>Please verify you are human</body></html>')));
    await expect(captcha.fetcher.get(RBI_LISTING_URL)).rejects.toMatchObject({ code: 'human_verification' });
    const real = setup((u) => (u.endsWith('/robots.txt') ? robots() : html('<html><body>Press Releases ... feedback form with captcha ... Treasury Bills: Full Auction Result</body></html>')));
    expect((await real.fetcher.get(RBI_LISTING_URL)).status).toBe(200);
  });
  it('errors are RbiFetchError with a stable code and a plain message that names no internals', async () => {
    const s = setup(() => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.5:443');
    });
    try {
      await s.fetcher.get(RBI_LISTING_URL);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RbiFetchError);
      expect((e as RbiFetchError).message).not.toMatch(/10\.0\.0\.5|ECONNREFUSED/);
    }
  });
});

describe('POST (the archive form)', () => {
  it('sends form-encoded fields, counts as one page request, and obeys the same rules', async () => {
    const { fetcher, calls } = setup(ok);
    await fetcher.post(RBI_LISTING_URL, { hdnYear: '2026', hdnMonth: '9', __VIEWSTATE: 'a b' });
    const c = calls[1];
    expect(c.init.method).toBe('POST');
    expect(String(c.init.body)).toBe('hdnYear=2026&hdnMonth=9&__VIEWSTATE=a+b');
    expect((c.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(fetcher.pageRequestsMade).toBe(1);
  });
});
