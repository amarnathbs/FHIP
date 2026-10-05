// NAV2 weekly RBI refresh: robots.txt handling (PO decision A, Stage 3) and loud blocking.
//
// Stage 3 on DEV: https://www.rbi.org.in/robots.txt answers with an HTML "Unauthorised Access" page (RBI's firewall), not a robots file, while
// the NSDP content page answers 200. RFC 9309: an UNAVAILABLE robots file (4xx other than 429, or not a robots file) means no rules are
// published, so the run continues and records `robots_unavailable_continued`; an UNREACHABLE one (5xx, 429, timeout, network, redirect) stops
// the run. A valid robots file that disallows the path is honoured. A refusal of a CONTENT page (403, 429, verification or "Unauthorised
// Access" page) is a hard stop of the whole run, reported as blocked_by_source with one alert review item, never retried or bypassed.
// Fixtures are synthetic pages built from the structure; no RBI page is committed.
//
// NAMED NEGATIVE CONTROLS
//   NC-RB1  the Unauthorised-Access robots page continues (and the page is then requested);   NC-RB2  a valid robots that disallows stops;
//   NC-RB3  a 5xx / 429 / timeout robots stops;   NC-RB4  an interstitial on a CONTENT page stops the run, nothing after it is requested;
//   NC-RB5  no PDF and no other host is ever requested;   NC-RB6  the repo reader on the NSDP fixture: confirm_unchanged when equal, a review
//   item when different;   NC-RB7  at most 4 pages, spacing and User-Agent still hold with robots unavailable.
import type { SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RISK_FREE_REFRESH_FETCH_POLICY as POLICY } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { isValidRobotsText, PoliteRbiFetcher, type FetcherDeps } from '@/lib/services/investment-intelligence/nav2/rbiFetcher';
import { createLiveRbiSource, RBI_LISTING_URL, RBI_NSDP_URL } from '@/lib/services/investment-intelligence/nav2/rbiSource';
import { REPO_SERIES, runRiskFreeRefresh, TBILL_SERIES } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshJob';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { listingHtml, nsdpHtml } from './support/rbiPages';

const UNAUTHORISED = '<html><head><title>Unauthorised Access</title></head><body><h1>Unauthorised Access</h1><p>Your request was blocked.</p></body></html>';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const isRobots = (u: string) => u.endsWith('/robots.txt');

function world(route: (url: string) => Response | Promise<Response>) {
  let now = 5_000_000;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deps: FetcherDeps = {
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return route(String(url));
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      now += ms;
    },
    nowMs: () => now,
  };
  const fetcher = new PoliteRbiFetcher(deps);
  return { fetcher, source: createLiveRbiSource(fetcher), calls };
}

describe('robots.txt: unavailable continues (RFC 9309), unreachable stops', () => {
  it('NC-RB1: the HTML "Unauthorised Access" page as robots.txt is NOT a robots file: no rules, the run continues and says so', async () => {
    const w = world((u) => (isRobots(u) ? html(UNAUTHORISED) : html(nsdpHtml())));
    const page = await w.fetcher.get(RBI_NSDP_URL);
    expect(page.status).toBe(200);
    expect(w.fetcher.robotsOutcome).toBe('robots_unavailable_continued');
    expect(w.calls.map((c) => c.url)).toEqual(['https://www.rbi.org.in/robots.txt', RBI_NSDP_URL]);
    expect(w.fetcher.robotsRequestsMade).toBe(1);
  });

  it('NC-RB1: a 401, 403 or 404 robots.txt, and a robots.txt of another content type, also continue', async () => {
    for (const bad of [() => html(UNAUTHORISED, 403), () => text('no', 401), () => text('missing', 404), () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }), () => html(UNAUTHORISED, 200)]) {
      const w = world((u) => (isRobots(u) ? bad() : html(nsdpHtml())));
      expect((await w.fetcher.get(RBI_NSDP_URL)).status).toBe(200);
      expect(w.fetcher.robotsOutcome).toBe('robots_unavailable_continued');
    }
  });

  it('a valid robots file is honoured and recorded as robots_ok (an empty one means no rules)', async () => {
    const ok = world((u) => (isRobots(u) ? text('User-agent: *\nDisallow: /secret/\n') : html(nsdpHtml())));
    await ok.fetcher.get(RBI_NSDP_URL);
    expect(ok.fetcher.robotsOutcome).toBe('robots_ok');
    const empty = world((u) => (isRobots(u) ? text('') : html(nsdpHtml())));
    await empty.fetcher.get(RBI_NSDP_URL);
    expect(empty.fetcher.robotsOutcome).toBe('robots_ok');
  });

  it('NC-RB2: a VALID robots.txt that disallows the path stops that request: the page is never requested', async () => {
    const w = world((u) => (isRobots(u) ? text('User-agent: *\nDisallow: /Scripts/\n') : html(nsdpHtml())));
    await expect(w.fetcher.get(RBI_NSDP_URL)).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(w.calls.filter((c) => !isRobots(c.url))).toEqual([]);
    expect(w.fetcher.robotsOutcome).toBe('robots_ok');
  });

  it('NC-RB2: the same disallow written as the "Unauthorised Access" page would NOT be a rule (the control: only a real file counts)', async () => {
    const w = world((u) => (isRobots(u) ? html(`${UNAUTHORISED}<!-- Disallow: / -->`) : html(nsdpHtml())));
    expect((await w.fetcher.get(RBI_NSDP_URL)).status).toBe(200);
  });

  it('NC-RB3: a 5xx, a 429, a redirect, a timeout and a network failure on robots.txt STOP the run (unreachable = disallow), with no page request', async () => {
    const bads: Array<() => Response> = [
      () => text('err', 500),
      () => html('<html>down</html>', 503),
      () => text('slow down', 429),
      () => new Response(null, { status: 301, headers: { location: 'https://www.rbi.org.in/other-robots.txt' } }),
      () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
      () => {
        throw new TypeError('connect ECONNREFUSED');
      },
    ];
    for (const bad of bads) {
      const w = world((u) => (isRobots(u) ? bad() : html(nsdpHtml())));
      await expect(w.fetcher.get(RBI_NSDP_URL)).rejects.toMatchObject({ code: 'robots_unavailable' });
      expect(w.calls.filter((c) => !isRobots(c.url))).toEqual([]);
      expect(w.fetcher.robotsOutcome).toBe('robots_unreachable');
    }
  });

  it('isValidRobotsText: real directive lines and an empty body are valid; any HTML page, a bare sentence or JSON is not', () => {
    expect(isValidRobotsText('')).toBe(true);
    expect(isValidRobotsText('﻿User-agent: *\nDisallow:\n')).toBe(true);
    expect(isValidRobotsText('# only a comment\nSitemap: https://www.rbi.org.in/sitemap.xml')).toBe(true);
    for (const bad of [UNAUTHORISED, '<!DOCTYPE html><html></html>', 'Unauthorised Access', '{"error":"blocked"}', '<html><body>User-agent: *\nDisallow: /</body></html>']) expect(isValidRobotsText(bad), bad).toBe(false);
  });
});

describe('a refusal of a CONTENT page stops the whole run, loudly (NC-RB4)', () => {
  const stored = (series: string, date: string, v: number) => ({ series_id: series, observation_date: date, kind: 'value', value_percent: v });
  const jobWorld = (route: (u: string) => Response, observations = [stored(TBILL_SERIES, '2026-09-23', 5.19), stored(REPO_SERIES, '2025-12-05', 5.25)]) => {
    const w = world(route);
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ ii_risk_free_observations: observations });
    const rpc = vi.fn(async () => ({ data: { inserted: 0, identical: 0, queued: 1 }, error: null }));
    const admin = Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc }) as unknown as SupabaseClient;
    const run = (dryRun = false) => runRiskFreeRefresh({ admin, source: w.source, ai: null, enabled: true, dryRun, todayIso: '2026-10-02' });
    return { ...w, rpc, run };
  };

  it('NC-RB4: the "Unauthorised Access" page, a 403 and a 429 from the listing stop the run: nothing after it is requested, ONE alert item is queued, no rate is written', async () => {
    for (const block of [() => html(UNAUTHORISED), () => html('forbidden', 403), () => html('slow down', 429)]) {
      const w = jobWorld((u) => (isRobots(u) ? html(UNAUTHORISED) : block()));
      const r = await w.run();
      expect(r.robots).toBe('robots_unavailable_continued');
      expect(r.sourceStatus).toBe('blocked_by_source');
      expect(r.fetchProblem?.code).toBe('human_verification');
      expect(r.tbill?.outcome).toBe('not_attempted');
      expect(r.requests).toEqual({ pages: 1, robots: 1 });
      expect(w.calls.filter((c) => !isRobots(c.url))).toHaveLength(1); // never retried, the NSDP page is not tried either
      expect(w.rpc).toHaveBeenCalledTimes(1);
      expect(w.rpc.mock.calls[0]).toEqual(['record_risk_free_refresh_results', expect.objectContaining({ p_series_id: TBILL_SERIES, p_rows: [], p_review_items: [expect.objectContaining({ reasons: ['blocked_by_source'], candidate: null, observation_date: null })] })]);
      expect(r.wrote.alert).toBe(true);
    }
  });

  it('NC-RB4: the NSDP page itself blocked (the cross-check) is NOT swallowed into "no reading": it is a block, reported', async () => {
    const asOf = [stored(TBILL_SERIES, '2026-09-30', 5.2), stored(REPO_SERIES, '2025-12-05', 5.25)]; // T-bill current: only the NSDP page is read
    const w = jobWorld((u) => (isRobots(u) ? html(UNAUTHORISED) : html(UNAUTHORISED)), asOf);
    const r = await w.run();
    expect(r.sourceStatus).toBe('blocked_by_source');
    expect(r.repo?.outcome).toBe('not_attempted'); // not "no_nsdp_reading": the Stage 3 symptom is gone
  });

  it('a dry run that is blocked writes nothing at all (no alert item either)', async () => {
    const w = jobWorld((u) => (isRobots(u) ? html(UNAUTHORISED) : html(UNAUTHORISED)));
    const r = await w.run(true);
    expect(r.sourceStatus).toBe('blocked_by_source');
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('an ordinary failure (a missing NSDP page) is reported as a cross-check gap, not as a block', async () => {
    const asOf = [stored(TBILL_SERIES, '2026-09-30', 5.2), stored(REPO_SERIES, '2025-12-05', 5.25)];
    const w = jobWorld((u) => (isRobots(u) ? html(UNAUTHORISED) : html('missing', 404)), asOf);
    const r = await w.run();
    expect(r.sourceStatus).toBe('ok');
    expect(r.repo?.outcome).toBe('no_nsdp_reading');
    expect(w.rpc).not.toHaveBeenCalled();
  });
});

describe('the repo reader on the NSDP page with robots unavailable (the Stage 3 situation, NC-RB6)', () => {
  const stored = (series: string, date: string, v: number) => ({ series_id: series, observation_date: date, kind: 'value', value_percent: v });
  const upToDateTbill = stored(TBILL_SERIES, '2026-09-30', 5.2);
  const go = async (repoStored: number) => {
    const w = world((u) => (isRobots(u) ? html(UNAUTHORISED) : html(nsdpHtml())));
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ ii_risk_free_observations: [upToDateTbill, stored(REPO_SERIES, '2025-12-05', repoStored)] });
    const rpc = vi.fn(async () => ({ data: { inserted: 0, identical: 0, queued: 0 }, error: null }));
    const admin = Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc }) as unknown as SupabaseClient;
    const report = await runRiskFreeRefresh({ admin, source: w.source, ai: null, enabled: true, dryRun: false, todayIso: '2026-10-02' });
    return { report, rpc, calls: w.calls };
  };

  it('NC-RB6: the stored repo rate equals the NSDP reading: confirm_unchanged, verified-through advances to the week, no observation row', async () => {
    const { report, rpc } = await go(5.25);
    expect(report.robots).toBe('robots_unavailable_continued');
    expect(report.sourceStatus).toBe('ok');
    expect(report.requests).toEqual({ pages: 1, robots: 1 });
    expect(report.tbill?.outcome).toBe('up_to_date');
    expect(report.repo?.outcome).toBe('confirm_unchanged');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]).toEqual(['record_risk_free_refresh_results', expect.objectContaining({ p_series_id: REPO_SERIES, p_rows: [], p_review_items: [], p_verified_through: '2026-09-25' })]);
  });

  it('NC-RB6: a DIFFERENT rate on the page is a review item with no candidate, and verified-through does not move', async () => {
    const { report, rpc } = await go(5.5);
    expect(report.repo?.outcome).toBe('review');
    expect(rpc.mock.calls[0]).toEqual(['record_risk_free_refresh_results', expect.objectContaining({ p_series_id: REPO_SERIES, p_rows: [], p_verified_through: null, p_review_items: [expect.objectContaining({ candidate: null })] })]);
  });
});

describe('every other safeguard still holds with robots unavailable (NC-RB5, NC-RB7)', () => {
  const full = (u: string) =>
    isRobots(u) ? html(UNAUTHORISED)
    : u.startsWith(RBI_LISTING_URL) ? html(listingHtml([{ date: 'Sep 30, 2026', items: [{ prid: '63696', title: 'Treasury Bills: Full Auction Result' }] }]))
    : u.includes('prid=') ? html('<html><body><p>Treasury Bills: Full Auction Result</p></body></html>')
    : html(nsdpHtml());

  it('NC-RB5: no PDF and no other host is requested, even though the listing links PDFs; every request carries the descriptive User-Agent', async () => {
    const w = world(full);
    const stored = (series: string, date: string, v: number) => ({ series_id: series, observation_date: date, kind: 'value', value_percent: v });
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ ii_risk_free_observations: [stored(TBILL_SERIES, '2026-09-23', 5.19), stored(REPO_SERIES, '2025-12-05', 5.25)] });
    const admin = Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc: vi.fn(async () => ({ data: {}, error: null })) }) as unknown as SupabaseClient;
    await runRiskFreeRefresh({ admin, source: w.source, ai: null, enabled: true, dryRun: true, todayIso: '2026-10-02' });
    expect(w.calls.length).toBeGreaterThan(2);
    for (const c of w.calls) {
      expect(new URL(c.url).hostname).toBe('www.rbi.org.in');
      expect(c.url).not.toMatch(/\.(pdf|xlsx?|docx?|zip)(\?|#|$)/i);
      expect((c.init.headers as Record<string, string>)['User-Agent']).toBe(POLICY.userAgent);
    }
    // a PDF URL is refused before any request
    const direct = world(full);
    await expect(direct.fetcher.get('https://www.rbi.org.in/rdocs/PressRelease/PDFs/PR1.PDF')).rejects.toMatchObject({ code: 'blocked_file_type' });
    expect(direct.calls).toEqual([]);
  });

  it('NC-RB7: at most maxRequestsPerRun pages, robots read once, requests spaced at least minSpacingMs apart', async () => {
    let now = 0;
    const stamps: number[] = [];
    const deps: FetcherDeps = {
      fetchImpl: (async (url: string) => {
        stamps.push(now);
        return isRobots(String(url)) ? html(UNAUTHORISED) : html(nsdpHtml());
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        now += ms;
      },
      nowMs: () => now,
    };
    const f = new PoliteRbiFetcher(deps);
    for (let i = 0; i < POLICY.maxRequestsPerRun; i++) await f.get(RBI_NSDP_URL);
    await expect(f.get(RBI_NSDP_URL)).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(f.pageRequestsMade).toBe(4);
    expect(f.robotsRequestsMade).toBe(1);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(POLICY.minSpacingMs);
  });
});

describe('monitoring signal (source contract)', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');
  it('the monitoring route and page carry the robots-unavailable and blocked counts; the cron route records one row per live attempt', () => {
    const route = read('app/api/admin/investment-intelligence/nav2-monitoring/route.ts');
    expect(route).toContain("rpc('nav2_refresh_attempt_summary')");
    const page = read('components/admin/Nav2MonitoringClient.tsx');
    expect(page).toContain('robots_unavailable_continued_last_90_days');
    expect(page).toContain('blocked_by_source_last_90_days');
    expect(page).toContain('RBI is blocking the weekly read');
    const cron = read('app/api/investment-intelligence/cron/nav2-risk-free-refresh/route.ts');
    expect(cron).toContain("from('ii_risk_free_refresh_attempts')");
    expect(cron).toContain('robots_outcome: report.robots');
  });
});
