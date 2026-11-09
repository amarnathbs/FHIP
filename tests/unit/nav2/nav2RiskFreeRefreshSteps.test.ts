// NAV2 -- the weekly RBI refresh run as three short steps (listing, release, decide), over fake RBI pages at HTTP level, a simulated clock,
// an in-memory stage table and an in-memory database. Written after the first production dry run answered HTTP 504: Amplify ends every
// request at 28 seconds, and the one-request run (robots + listing + release + weekly page, paced politely) did not fit.
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  the three steps decide and write EXACTLY what the one-request run decides and writes on the same pages (no second rulebook);
//   NC-S2  every step ends inside the 28 seconds even when RBI takes six seconds per request, and a step only ever asks for its own page;
//   NC-S3  switch off: no request, no read of the stage table, no write of any kind;
//   NC-S4  a dry run never calls the database function and never marks the week done (its only write is the scratch stage row);
//   NC-S5  once a live decide has finished, later calls make no request at all;
//   NC-S6  robots.txt is read once for the week, not once per step;
//   NC-S7  a refusal by RBI stops the job: one alert, six hours of silence (even for a dry run), then it starts again;
//   NC-S8  a release that is not out yet writes nothing and is tried again after the waiting time;
//   NC-S9  a week whose T-bill is already stored never touches the listing or the release;
//   NC-S10 a weekly page that cannot be read once is asked for again before the gate is allowed to decide without it;
//   NC-S11 damaged or old stage evidence starts the week again; the release address kept in the table is re-checked before it is requested;
//   NC-S12 a slow site that cannot finish a step inside its deadline gives a clear "try again" answer, never a 504, and nothing is saved.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { RISK_FREE_REFRESH_FETCH_POLICY, RISK_FREE_REFRESH_STEP_MAX_REQUESTS, stepFetchPolicy } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { PoliteRbiFetcher, type FetcherDeps } from '@/lib/services/investment-intelligence/nav2/rbiFetcher';
import { createLiveRbiSource, RBI_LISTING_URL } from '@/lib/services/investment-intelligence/nav2/rbiSource';
import { parseEvidence, runRefreshStep, type StageRow, type StageStore, type StepReport } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshSteps';
import { REPO_SERIES, runRiskFreeRefresh, TBILL_SERIES } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshJob';
import { createInMemoryDb, type Row } from '../support/inMemorySupabase';
import { listingHtml, nsdpHtml, releaseHtml } from './support/rbiPages';

const TODAY = '2026-10-02'; // a Friday: the expected auction is Wednesday 30-09-2026
const EXPECTED = '2026-09-30';
const BASE = Date.parse('2026-10-02T03:30:00.000Z');
const UNAUTHORISED = '<html><head><title>Unauthorised Access</title></head><body><h1>Unauthorised Access</h1></body></html>';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const isRobots = (u: string) => u.endsWith('/robots.txt');
const stored = (date: string, v: number, series = TBILL_SERIES): Row => ({ series_id: series, observation_date: date, kind: 'value', value_percent: v });
const LISTING = listingHtml([{ date: 'Sep 30, 2026', items: [{ prid: '63696', title: 'Treasury Bills: Full Auction Result' }] }]);
const RELEASE = releaseHtml({ price: ['98.7203', '97.2000', '94.3000'], ytm: ['(YTM: 5.2000%)', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] });
const NSDP = nsdpHtml({ yields: ['5.47', '5.26', '5.26', '5.21', '5.28', '5.20'] });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function memoryStore(): StageStore & { rows: Map<string, StageRow>; loads: number; saves: number } {
  const rows = new Map<string, StageRow>();
  const s = {
    rows,
    loads: 0,
    saves: 0,
    async load(expected: string) {
      s.loads += 1;
      return rows.get(expected) ?? null;
    },
    async save(row: Omit<StageRow, 'updatedAt'>, nowIso: string) {
      s.saves += 1;
      rows.set(row.expectedAuctionDate, { ...row, updatedAt: nowIso });
    },
  };
  return s;
}

function world(over: { observations?: Row[]; route?: Route; latencyMs?: number } = {}) {
  let now = 5_000_000;
  let minutes = 0; // wall-clock offset of the call, in minutes after 03:30 UTC on TODAY
  const calls: Array<{ url: string; method: string; at: number }> = [];
  const latency = over.latencyMs ?? 1500;
  const defaultRoute: Route = (u, init) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html(NSDP) : init.method === 'POST' || u.startsWith(RBI_LISTING_URL) ? html(LISTING) : html(NSDP));
  const current = (): Route => over.route ?? defaultRoute;
  const deps: FetcherDeps = {
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', at: now });
      now += latency; // the time the site takes to answer
      return current()(String(url), init);
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      now += ms;
    },
    nowMs: () => now,
  };
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ ii_risk_free_observations: over.observations ?? [stored('2026-09-23', 5.19), stored('2025-12-05', 5.25, REPO_SERIES)] });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: { batch_id: 'b', inserted: (args.p_rows as unknown[]).length, identical: 0, queued: (args.p_review_items as unknown[]).length, name }, error: null }));
  const admin = Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc }) as unknown as SupabaseClient;
  const store = memoryStore();
  const w = {
    db,
    rpc,
    admin,
    store,
    calls,
    deps,
    setRoute(r: Route) {
      (over as { route?: Route }).route = r;
    },
    advanceMinutes(m: number) {
      minutes += m;
    },
    /** One call of the route's core: the NEXT step. */
    step(o: Partial<{ enabled: boolean; dryRun: boolean }> = {}) {
      return runRefreshStep({
        admin,
        store,
        makeSource: (step, robots) => createLiveRbiSource(new PoliteRbiFetcher(deps, stepFetchPolicy(step), robots)),
        ai: null,
        enabled: o.enabled ?? true,
        dryRun: o.dryRun ?? false,
        todayIso: TODAY,
        nowIso: new Date(BASE + minutes * 60_000).toISOString(),
        nowMs: () => now,
      });
    },
  };
  return w;
}

const pageCalls = (w: ReturnType<typeof world>) => w.calls.filter((c) => !isRobots(c.url));
const robotsCalls = (w: ReturnType<typeof world>) => w.calls.filter((c) => isRobots(c.url));
const rpcRows = (w: ReturnType<typeof world>, series: string) => w.rpc.mock.calls.filter((c) => c[1].p_series_id === series).map((c) => c[1]);

describe('the three steps and the one-request run decide the same thing (NC-S1)', () => {
  it('on identical pages the staged live run writes exactly what the one-request run writes', async () => {
    const staged = world();
    const r1 = await staged.step();
    const r2 = await staged.step();
    const r3 = await staged.step();
    expect([r1.report.step, r2.report.step, r3.report.step]).toEqual(['listing', 'release', 'decide']);
    expect(r3.report.tbill).toMatchObject({ outcome: 'publish', auctionDate: EXPECTED, yieldPercent: 5.2 });

    const single = world();
    const done = await runRiskFreeRefresh({ admin: single.admin, source: createLiveRbiSource(new PoliteRbiFetcher(single.deps)), ai: null, enabled: true, dryRun: false, todayIso: TODAY });
    expect(done.tbill).toMatchObject({ outcome: 'publish', auctionDate: EXPECTED, yieldPercent: 5.2 });

    expect(staged.rpc.mock.calls).toEqual(single.rpc.mock.calls); // same function, same arguments, same order
    expect(rpcRows(staged, TBILL_SERIES)[0].p_rows).toMatchObject([{ date: EXPECTED, kind: 'value', value_percent: 5.2, source_url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696' }]);
    expect(rpcRows(staged, REPO_SERIES)[0]).toMatchObject({ p_verified_through: '2026-09-25', p_rows: [] });
    // and the whole week asks RBI for the same pages as before
    expect(pageCalls(staged).map((c) => c.url)).toEqual(pageCalls(single).map((c) => c.url));
  });

  it('a disagreement or a missing cross-check still publishes nothing when staged (the gate is shared)', async () => {
    const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html('<html>gone</html>', 404) : html(LISTING)) });
    await w.step();
    await w.step();
    const first = await w.step(); // NSDP could not be read: asked once more before deciding
    expect(first.report.step).toBe('decide');
    expect(first.report.tbill).toBeUndefined();
    expect(w.rpc).not.toHaveBeenCalled();
    const second = await w.step();
    expect(second.report.tbill).toMatchObject({ outcome: 'review' });
    expect(second.report.tbill?.reasons).toContain('single_read_needs_nsdp_match');
    expect(rpcRows(w, TBILL_SERIES)[0].p_rows).toEqual([]);
  });
});

describe('every step fits the 28 seconds and asks only for its own page (NC-S2, NC-S6)', () => {
  it('with RBI taking six seconds per request each step stays well under 28 seconds', async () => {
    const w = world({ latencyMs: 6000 });
    for (const expectedStep of ['listing', 'release', 'decide']) {
      const r = await w.step();
      expect(r.report.step).toBe(expectedStep);
      expect(r.report.elapsedMs, expectedStep).toBeLessThan(24_000);
      expect(r.report.fetchProblem).toBeNull();
      for (const ms of r.report.requestMillis) expect(ms).toBe(6000);
    }
  });

  it('listing asks for robots.txt and the listing; release only the release; decide only the weekly page; robots.txt once for the whole week', async () => {
    const w = world();
    const a = await w.step();
    expect(a.report.requests).toEqual({ pages: 1, robots: 1 });
    expect(w.calls.map((c) => c.url.replace('https://www.rbi.org.in', ''))).toEqual(['/robots.txt', '/Scripts/BS_PressReleaseDisplay.aspx']);
    w.calls.length = 0;
    const b = await w.step();
    expect(b.report.requests).toEqual({ pages: 1, robots: 0 });
    expect(w.calls.map((c) => c.url)).toEqual(['https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696']);
    w.calls.length = 0;
    const c = await w.step();
    expect(c.report.requests).toEqual({ pages: 1, robots: 0 });
    expect(w.calls.map((x) => x.url)).toEqual(['https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?param=4'.replace('BS_PressReleaseDisplay', 'BS_NSDPDisplay')]);
    expect(c.report.weekRequests).toEqual({ pages: 3, robots: 1 });
    // robots.txt was read ONCE in the whole week, and its outcome travelled with the stage row
    expect(w.store.rows.get(EXPECTED)?.evidence.robots?.outcome).toBe('robots_unavailable_continued');
  });

  it('a month listing for another month needs the archive form: the listing step then makes two page requests, still inside the budget', async () => {
    const other = listingHtml([{ date: 'Oct 1, 2026', items: [{ prid: '1', title: 'Something else' }] }], { __VIEWSTATE: 'VS', __EVENTVALIDATION: 'EV', hdnYear: '2026', hdnMonth: '10' });
    const w = world({ latencyMs: 4000, route: (u, init) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html(NSDP) : init.method === 'POST' ? html(LISTING) : html(other)) });
    const a = await w.step();
    expect(a.report.requests).toEqual({ pages: 2, robots: 1 });
    expect(a.report.listing).toMatchObject({ found: true, releaseDate: EXPECTED });
    expect(a.report.elapsedMs).toBeLessThan(24_000);
  });

  it('the per-step request caps add up to the original four pages per run, and the step deadline plus one request fits under 28 seconds', () => {
    expect(RISK_FREE_REFRESH_STEP_MAX_REQUESTS.listing + RISK_FREE_REFRESH_STEP_MAX_REQUESTS.release + RISK_FREE_REFRESH_STEP_MAX_REQUESTS.decide).toBe(RISK_FREE_REFRESH_FETCH_POLICY.maxRequestsPerRun);
    for (const s of ['listing', 'release', 'decide'] as const) {
      const p = stepFetchPolicy(s);
      expect(p.runDeadlineMs + p.perRequestTimeoutMs).toBeLessThanOrEqual(22_000);
      expect(p.minSpacingMs).toBe(RISK_FREE_REFRESH_FETCH_POLICY.minSpacingMs); // politeness is not relaxed
      expect(p.userAgent).toBe(RISK_FREE_REFRESH_FETCH_POLICY.userAgent);
    }
  });

  it('NC-S12: a site so slow that a step cannot finish inside its deadline gives a clear "try again" answer and saves nothing', async () => {
    const other = listingHtml([{ date: 'Oct 1, 2026', items: [{ prid: '1', title: 'Something else' }] }], { __VIEWSTATE: 'VS', __EVENTVALIDATION: 'EV', hdnYear: '2026', hdnMonth: '10' });
    const w = world({ latencyMs: 9000, route: (u) => (isRobots(u) ? html(UNAUTHORISED) : html(other)) });
    const r = await w.step();
    expect(r.report.fetchProblem?.code).toBe('deadline');
    expect(r.report.elapsedMs).toBeLessThan(28_000);
    expect(r.report.retryNotBefore).toBeUndefined(); // slowness is not a refusal: the next call simply tries again
    expect(w.store.saves).toBe(0);
    expect(r.attempt).toMatchObject({ failed: true, fetch_problem_code: 'deadline' });
  });
});

describe('switch and dry run (NC-S3, NC-S4, NC-S5)', () => {
  it('NC-S3: switch off makes no request, reads no stage row and writes nothing', async () => {
    const w = world();
    const r = await w.step({ enabled: false });
    expect(r.report).toMatchObject({ mode: 'skipped_kill_switch', step: 'skipped_kill_switch', requests: { pages: 0, robots: 0 } });
    expect(w.calls).toEqual([]);
    expect(w.store.loads).toBe(0);
    expect(w.store.saves).toBe(0);
    expect(w.rpc).not.toHaveBeenCalled();
    expect(w.db.reads).toEqual([]);
    expect(r.attempt).toBeNull();
  });

  it('NC-S4: three dry-run calls report what would be published and call no database function; the week is not marked done', async () => {
    const w = world();
    const reports: StepReport[] = [];
    for (let i = 0; i < 3; i++) reports.push((await w.step({ dryRun: true })).report);
    expect(reports.map((r) => r.step)).toEqual(['listing', 'release', 'decide']);
    expect(reports[1].reading?.parser).toMatchObject({ auctionDate: EXPECTED, cutoffYieldPercent: 5.2 });
    expect(reports[2].tbill).toMatchObject({ outcome: 'publish', auctionDate: EXPECTED, yieldPercent: 5.2 });
    expect(reports[2].wrote).toEqual({ tbill: null, repo: null });
    expect(w.rpc).not.toHaveBeenCalled();
    expect(w.db.writes).toEqual([]);
    expect(w.store.rows.get(EXPECTED)?.decidedLiveAt).toBeNull();
    // a dry run never produces an attempt row, a failure count or a success stamp
    for (const r of [await w.step({ dryRun: true })]) expect(r.attempt).toBeNull();
    // and a LIVE decide afterwards still writes: the dry run did not use the week up
    const live = await w.step({ dryRun: false });
    expect(live.report.step).toBe('decide');
    expect(rpcRows(w, TBILL_SERIES)).toHaveLength(1);
  });

  it('NC-S5: after a live decide has finished, further calls make no request and say the week is done', async () => {
    const w = world();
    for (let i = 0; i < 3; i++) await w.step();
    expect(w.store.rows.get(EXPECTED)?.decidedLiveAt).toBeTruthy();
    const before = w.calls.length;
    for (let i = 0; i < 3; i++) {
      w.advanceMinutes(5);
      const r = await w.step();
      expect(r.report.step).toBe('complete');
      expect(r.report.requests).toEqual({ pages: 0, robots: 0 });
      expect(r.attempt).toBeNull();
    }
    expect(w.calls.length).toBe(before);
    expect(w.rpc.mock.calls.filter((c) => c[1].p_series_id === TBILL_SERIES)).toHaveLength(1);
  });

  it('a live week that finishes leaves ONE attempt record with the whole week\'s request counts', async () => {
    const w = world();
    await w.step();
    await w.step();
    const last = await w.step();
    expect(last.attempt).toMatchObject({ failed: false, source_status: 'ok', tbill_outcome: 'publish', repo_outcome: 'confirm_unchanged', pages_requested: 3, robots_requests: 1, robots_outcome: 'robots_unavailable_continued' });
  });
});

describe('a refusal by RBI stops the job (NC-S7)', () => {
  const blocked: Route = (u) => (isRobots(u) ? html(UNAUTHORISED) : html('forbidden', 403));

  it('a 403 on the listing: one alert item, no rate, six hours of silence, then it starts again', async () => {
    const w = world({ route: blocked });
    const r = await w.step();
    expect(r.report).toMatchObject({ step: 'listing', sourceStatus: 'blocked_by_source', fetchProblem: { code: 'human_verification' } });
    expect(r.report.retryNotBefore).toBe('2026-10-02T09:30:00.000Z');
    expect(w.rpc).toHaveBeenCalledTimes(1);
    expect(w.rpc.mock.calls[0][1]).toMatchObject({ p_series_id: TBILL_SERIES, p_rows: [], p_review_items: [{ reasons: ['blocked_by_source'], candidate: null }] });
    expect(r.attempt).toMatchObject({ failed: true, source_status: 'blocked_by_source', fetch_problem_code: 'human_verification' });

    const requestsSoFar = w.calls.length;
    w.advanceMinutes(5);
    const wait = await w.step();
    expect(wait.report.step).toBe('waiting');
    expect(w.calls.length).toBe(requestsSoFar); // not one more request while cooling off
    expect(w.rpc).toHaveBeenCalledTimes(1); // and no second alert

    w.advanceMinutes(6 * 60);
    w.setRoute((u) => (isRobots(u) ? html(UNAUTHORISED) : html(LISTING)));
    const again = await w.step();
    expect(again.report.step).toBe('listing');
    expect(again.report.fetchProblem).toBeNull();
    expect(w.calls.length).toBeGreaterThan(requestsSoFar);
  });

  it('a block found while reading the release or the weekly page also stops the job and cools off', async () => {
    for (const blockedAt of ['release', 'nsdp'] as const) {
      const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : blockedAt === 'release' && u.includes('prid=') ? html(UNAUTHORISED) : blockedAt === 'nsdp' && u.includes('NSDP') ? html(UNAUTHORISED) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html(NSDP) : html(LISTING)) });
      await w.step();
      if (blockedAt === 'nsdp') await w.step();
      const r = await w.step();
      expect(r.report.sourceStatus, blockedAt).toBe('blocked_by_source');
      expect(r.report.retryNotBefore, blockedAt).toBeTruthy();
      expect(w.rpc.mock.calls.filter((c) => (c[1].p_rows as unknown[]).length > 0)).toEqual([]); // no rate written
      const n = w.calls.length;
      w.advanceMinutes(5);
      expect((await w.step()).report.step).toBe('waiting');
      expect(w.calls.length).toBe(n);
    }
  });

  it('a dry run that is blocked writes no alert and no rate, but still cools off (politeness does not depend on the mode)', async () => {
    const w = world({ route: blocked });
    const r = await w.step({ dryRun: true });
    expect(r.report.sourceStatus).toBe('blocked_by_source');
    expect(w.rpc).not.toHaveBeenCalled();
    expect(r.attempt).toBeNull();
    w.advanceMinutes(5);
    expect((await w.step({ dryRun: true })).report.step).toBe('waiting');
  });

  it('an ordinary failure (a timeout-like 500 on the listing) is not a refusal: nothing is saved and the next call simply tries the step again', async () => {
    const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : html('oops', 500)) });
    const r = await w.step();
    expect(r.report.fetchProblem?.code).toBe('http_error');
    expect(r.report.sourceStatus).toBe('fetch_problem');
    expect(r.report.retryNotBefore).toBeUndefined();
    expect(w.store.saves).toBe(0);
    expect(w.rpc).not.toHaveBeenCalled();
    w.advanceMinutes(5);
    w.setRoute((u) => (isRobots(u) ? html(UNAUTHORISED) : html(LISTING)));
    expect((await w.step()).report.step).toBe('listing');
  });

  it('a robots.txt that disallows the pages stops the job without requesting a page', async () => {
    const w = world({ route: (u) => (isRobots(u) ? text('User-agent: *\nDisallow: /Scripts/') : html(LISTING)) });
    const r = await w.step();
    expect(r.report.fetchProblem?.code).toBe('robots_disallowed');
    expect(pageCalls(w)).toEqual([]);
    expect(r.report.retryNotBefore).toBeTruthy();
  });
});

describe('a release that is not out yet (NC-S8)', () => {
  it('writes nothing, waits six hours, then reads the release when it is out', async () => {
    const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('NSDP') ? html(NSDP) : html(listingHtml([{ date: 'Sep 23, 2026', items: [{ prid: '63000', title: 'Treasury Bills: Full Auction Result' }] }]))) });
    const a = await w.step();
    expect(a.report.listing).toMatchObject({ found: false });
    const d = await w.step(); // no release to read: this call is already the decide step
    expect(d.report.step).toBe('decide');
    expect(d.report.tbill).toMatchObject({ outcome: 'no_release_yet' });
    expect(w.rpc.mock.calls.some((c) => c[1].p_series_id === TBILL_SERIES && ((c[1].p_rows as unknown[]).length > 0 || (c[1].p_review_items as unknown[]).length > 0))).toBe(false);
    expect(d.report.retryNotBefore).toBe('2026-10-02T09:30:00.000Z');
    expect(w.store.rows.get(EXPECTED)?.decidedLiveAt).toBeNull();

    w.advanceMinutes(5);
    expect((await w.step()).report.step).toBe('waiting');
    w.advanceMinutes(6 * 60);
    w.setRoute((u) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html(NSDP) : html(LISTING)));
    expect((await w.step()).report.step).toBe('listing');
    await w.step();
    const done = await w.step();
    expect(done.report.tbill).toMatchObject({ outcome: 'publish', yieldPercent: 5.2 });
  });
});

describe('a week whose T-bill is already stored (NC-S9)', () => {
  it('never touches the listing or the release: the weekly page alone confirms the policy rate', async () => {
    const w = world({ observations: [stored(EXPECTED, 5.2), stored('2025-12-05', 5.25, REPO_SERIES)] });
    const a = await w.step();
    expect(a.report.step).toBe('listing');
    expect(a.report.requests).toEqual({ pages: 0, robots: 0 });
    expect(w.calls).toEqual([]);
    const d = await w.step();
    expect(d.report.step).toBe('decide');
    expect(d.report.tbill?.outcome).toBe('up_to_date');
    expect(d.report.repo?.outcome).toBe('confirm_unchanged');
    expect(w.calls.map((c) => c.url)).toEqual(['https://www.rbi.org.in/robots.txt', 'https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4']);
    expect(w.rpc.mock.calls.some((c) => c[1].p_series_id === TBILL_SERIES)).toBe(false);
  });
});

describe('the weekly page cannot be read once (NC-S10)', () => {
  it('is asked for again; a repo rate that differs is still only a review item and never a row', async () => {
    let nsdpAnswers = 0;
    const w = world({
      observations: [stored(EXPECTED, 5.2), stored('2025-12-05', 5.25, REPO_SERIES)],
      route: (u) => (isRobots(u) ? html(UNAUTHORISED) : (nsdpAnswers += 1) === 1 ? html('missing', 404) : html(nsdpHtml({ repo: ['5.50', '5.25', '5.25', '5.25', '5.25', '5.00'] }))),
    });
    await w.step(); // listing: nothing to read
    const first = await w.step();
    expect(first.report.repo).toBeUndefined();
    expect(w.rpc).not.toHaveBeenCalled();
    const second = await w.step();
    expect(second.report.repo).toMatchObject({ outcome: 'review' });
    const repoCall = rpcRows(w, REPO_SERIES)[0];
    expect(repoCall.p_rows).toEqual([]);
    expect(repoCall.p_verified_through).toBeNull();
    expect(repoCall.p_review_items).toMatchObject([{ reasons: ['repo_change_without_policy_evidence'], candidate: null }]);
  });
});

describe('what is kept between steps is checked (NC-S11)', () => {
  it('parseEvidence refuses anything that is not exactly the evidence shape', () => {
    const good = { v: 1, jobVersion: 'x', startedOn: TODAY, tbillDue: true, robots: null, counts: { pages: 0, robots: 0 }, listing: null, reading: null, nsdpTries: 0 };
    expect(parseEvidence(good)).not.toBeNull();
    for (const bad of [null, 'text', [], { ...good, v: 2 }, { ...good, tbillDue: 'yes' }, { ...good, counts: { pages: 'a', robots: 0 } }, { ...good, listing: { found: true } }, { ...good, listing: { found: false } }, { ...good, reading: { parser: 5, ai: null } }, { ...good, robots: { outcome: 'robots_unreachable', text: '' } }]) expect(parseEvidence(bad)).toBeNull();
    expect(parseEvidence({ ...good, listing: { found: true, prid: '1', url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=1', releaseDate: EXPECTED } })).not.toBeNull();
  });

  it('a row older than 48 hours that never finished is abandoned and the week starts again from the listing', async () => {
    const w = world();
    await w.step();
    expect(w.store.rows.get(EXPECTED)?.step).toBe('listing_done');
    w.advanceMinutes(49 * 60);
    expect((await w.step()).report.step).toBe('listing');
  });

  it('the release address kept in the table is checked again: only an RBI press-release page is ever requested', async () => {
    const w = world();
    const source = createLiveRbiSource(new PoliteRbiFetcher(w.deps));
    for (const url of ['https://evil.example.com/x', 'https://www.rbi.org.in/rdocs/PressRelease/PDFs/PR1.PDF', 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=1&x=2', 'http://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=1', 'https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4']) {
      await expect(source.readReleasePage(url), url).rejects.toMatchObject({ code: 'blocked_host' });
    }
    expect(w.calls).toEqual([]);
    await expect(source.readReleasePage('https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696')).resolves.toContain('Treasury Bills');
  });

  it('a listing date that differs from the page\'s own date makes the parser untrusted, exactly as in the one-request run', async () => {
    const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(releaseHtml({ price: ['98.7203', '97.2', '94.3'], ytm: ['(YTM: 5.2000%)', '(YTM: 5.9%)', '(YTM: 6.2%)'], dateText: 'Oct 1, 2026' })) : u.includes('NSDP') ? html(NSDP) : html(LISTING)) });
    await w.step();
    const rel = await w.step();
    expect(rel.report.reading?.parser).toBeNull();
    const dec = await w.step();
    expect(dec.report.tbill).toMatchObject({ outcome: 'review', reasons: ['parser_failed_and_ai_unavailable'] });
  });
});
