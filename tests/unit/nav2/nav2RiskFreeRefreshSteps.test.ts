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
import type { Mailer, OutgoingMail } from '@/lib/services/premiumReminderMailer';
import { ALERT_SEND_TIMEOUT_MS, buildRefreshAlert, sendRefreshAlert } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshAlert';
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
  // A realistic recent history: one value for each of the four weeks before the current one, so catch-up (PO decision 13-11-2026) finds nothing missing.
  db.reset({ ii_risk_free_observations: over.observations ?? [stored('2026-09-02', 5.1), stored('2026-09-09', 5.15), stored('2026-09-16', 5.17), stored('2026-09-23', 5.19), stored('2025-12-05', 5.25, REPO_SERIES)] });
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
    step(o: Partial<{ enabled: boolean; dryRun: boolean; today: string; nowIso: string; alert: { mailer: Mailer; to: string } | null }> = {}) {
      return runRefreshStep({
        admin,
        store,
        makeSource: (step, robots) => createLiveRbiSource(new PoliteRbiFetcher(deps, stepFetchPolicy(step), robots)),
        ai: null,
        enabled: o.enabled ?? true,
        dryRun: o.dryRun ?? false,
        todayIso: o.today ?? TODAY,
        nowIso: o.nowIso ?? new Date(BASE + minutes * 60_000).toISOString(),
        nowMs: () => now,
        ...(o.alert !== undefined ? { alert: o.alert } : {}),
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

// =====================================================================================================================================================
// CATCH-UP AND E-MAIL ALERT (PO decision 13-11-2026: "build both catch-up and e-mail alert")
//   NC-C1  once the current week is done the next calls load the NEWEST missing earlier week (within four weeks) with the same gate, marked nsdp_not_comparable;
//   NC-C2  a week that already has a row Monday to Friday (a holiday-shifted Thursday auction) is covered: no catch-up;
//   NC-C3  an earlier week that was already DECIDED (for example sent to review) is never retried;
//   NC-C4  a refusal by RBI on ANY auction stops requests for EVERY auction; a release that is merely not out yet for an old week does not block the current one;
//   NC-C5  catch-up never starts while the current week still needs work, and nothing older than the four-week window is looked for;
//   NC-C6  a dry run catch-up writes no rate and marks nothing done;
//   NC-A1  a result sent to review is e-mailed ONCE (only when the review item is new), with dd-mm-yyyy dates and the gate's reason codes;
//   NC-A2  a refusal by RBI is e-mailed once;
//   NC-A3  a week still not loaded after the Saturday retry is recorded and e-mailed once, and not before the deadline or when the week is stored;
//   NC-A4  a dry run never sends; no setting = not_configured; a failing, throwing or slow mailer never changes the step's answer.
// =====================================================================================================================================================
const priceFor = (y: number): number => Math.round((100 / (1 + (y / 100) * (91 / 365))) * 10000) / 10000;
const LISTING_WITH_SEP16 = listingHtml([
  { date: 'Sep 30, 2026', items: [{ prid: '63696', title: 'Treasury Bills: Full Auction Result' }] },
  { date: 'Sep 16, 2026', items: [{ prid: '63500', title: 'Treasury Bills: Full Auction Result' }] },
]);
const RELEASE_SEP16 = releaseHtml({ dateText: 'Sep 16, 2026', price: ['98.7274', '97.2000', '94.3000'], ytm: ['(YTM: 5.1700%)', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] });
const catchUpRoute: Route = (u, init) =>
  isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=63500') ? html(RELEASE_SEP16) : u.includes('prid=') ? html(RELEASE) : u.includes('NSDP') ? html(NSDP) : init.method === 'POST' || u.startsWith(RBI_LISTING_URL) ? html(LISTING_WITH_SEP16) : html(NSDP);
const SEP16 = '2026-09-16';
const REPO_ROW = stored('2025-12-05', 5.25, REPO_SERIES);
const missingSep16 = [stored('2026-09-02', 5.1), stored('2026-09-09', 5.15), stored('2026-09-23', 5.19), REPO_ROW];

const evidenceFor = (over: Partial<StageRow['evidence']> = {}): StageRow['evidence'] => ({ v: 1, jobVersion: 'seed', startedOn: TODAY, tbillDue: true, robots: null, counts: { pages: 0, robots: 0 }, listing: null, reading: null, nsdpTries: 0, ...over });
const seedRow = (w: ReturnType<typeof world>, date: string, over: Partial<Omit<StageRow, 'expectedAuctionDate'>> = {}) =>
  w.store.rows.set(date, { expectedAuctionDate: date, step: 'release_done', evidence: evidenceFor(), retryNotBefore: null, decidedLiveAt: null, updatedAt: new Date(BASE).toISOString(), ...over });

async function finishCurrentWeek(w: ReturnType<typeof world>): Promise<void> {
  for (let i = 0; i < 3; i += 1) await w.step(); // listing, release, decide of the current week
  expect(w.store.rows.get(EXPECTED)?.decidedLiveAt).toBeTruthy();
}

describe('catch-up of a missed earlier auction', () => {
  it('NC-C1: after the current week, the newest missing earlier week is loaded by the same three steps, publishes, and is marked nsdp_not_comparable', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    await finishCurrentWeek(w);
    const a = await w.step();
    expect(a.report).toMatchObject({ step: 'listing', catchUp: true, expectedAuctionDate: SEP16 });
    const b = await w.step();
    expect(b.report).toMatchObject({ step: 'release', catchUp: true, expectedAuctionDate: SEP16 });
    const c = await w.step();
    expect(c.report).toMatchObject({ step: 'decide', catchUp: true, expectedAuctionDate: SEP16, tbill: { outcome: 'publish', auctionDate: SEP16, yieldPercent: 5.17 } });
    const calls = rpcRows(w, TBILL_SERIES);
    const row = (calls[calls.length - 1].p_rows as Array<Record<string, unknown>>)[0] as { date: string; value_percent: number; extraction: { checksPassed: string[]; method: string } };
    expect(row).toMatchObject({ date: SEP16, value_percent: 5.17 });
    expect(row.extraction.method).toBe('parser');
    expect(row.extraction.checksPassed).toEqual(['price_recompute', 'plausible_band', 'nsdp_not_comparable', 'auction_date']);
    expect(row.extraction.checksPassed).not.toContain('nsdp_pending'); // the back-check must not look for it: the page has moved past that week
    expect(w.store.rows.get(SEP16)?.decidedLiveAt).toBeTruthy();
    const after = await w.step(); // nothing left to do: the current week says complete
    expect(after.report.step).toBe('complete');
    expect(after.report.catchUp).toBeUndefined();
  });

  it('NC-C1: the band reference of a catch-up is the nearest value BEFORE its date: a catch-up far from it goes to review, never published', async () => {
    const w = world({ observations: [stored('2026-09-02', 4.5), stored('2026-09-09', 4.6), stored('2026-09-23', 5.19), REPO_ROW], route: catchUpRoute }); // 5.17 is 0.57 above the value before 16-09
    await finishCurrentWeek(w);
    await w.step();
    await w.step();
    const c = await w.step();
    expect(c.report.tbill).toMatchObject({ outcome: 'review', reasons: ['outside_plausible_band'] });
    const calls = rpcRows(w, TBILL_SERIES);
    expect((calls[calls.length - 1].p_rows as unknown[]).length).toBe(0);
  });

  it('NC-C2: a week with a row dated Monday to Friday (a holiday-shifted Thursday auction) is covered: nothing is caught up', async () => {
    const w = world({ observations: [stored('2026-09-02', 5.1), stored('2026-09-09', 5.15), stored('2026-09-17', 5.17), stored('2026-09-23', 5.19), REPO_ROW], route: catchUpRoute });
    await finishCurrentWeek(w);
    const requests = w.calls.length;
    const r = await w.step();
    expect(r.report.step).toBe('complete');
    expect(w.calls.length).toBe(requests);
  });

  it('NC-C3: an earlier week that was already DECIDED (for example sent to review) is never retried', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    seedRow(w, SEP16, { decidedLiveAt: '2026-10-01T03:40:00.000Z' });
    await finishCurrentWeek(w);
    const requests = w.calls.length;
    const r = await w.step();
    expect(r.report.step).toBe('complete');
    expect(w.calls.length).toBe(requests);
  });

  it('NC-C4: a refusal by RBI while reading an OLD week stops requests for EVERY auction until its waiting time is over', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    seedRow(w, SEP16, { retryNotBefore: '2026-10-02T09:30:00.000Z', evidence: evidenceFor({ refused: true }) });
    const r = await w.step(); // the current week has no row and would normally start now
    expect(r.report).toMatchObject({ step: 'waiting', retryNotBefore: '2026-10-02T09:30:00.000Z' });
    expect(w.calls.length).toBe(0);
  });

  it('NC-C4: a release that is merely not out yet for an old week (not a refusal) does NOT block the current week', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    seedRow(w, SEP16, { retryNotBefore: '2026-10-02T09:30:00.000Z', evidence: evidenceFor({ refused: false }) });
    const r = await w.step();
    expect(r.report).toMatchObject({ step: 'listing', expectedAuctionDate: EXPECTED });
    expect(r.report.catchUp).toBeUndefined();
  });

  it('NC-C4: while the current week waits for a release that is not out yet, an earlier missed week is still caught up', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    seedRow(w, EXPECTED, { retryNotBefore: '2026-10-02T09:30:00.000Z', evidence: evidenceFor({ refused: false }) });
    const r = await w.step();
    expect(r.report).toMatchObject({ step: 'listing', catchUp: true, expectedAuctionDate: SEP16 });
  });

  it('NC-C5: catch-up never starts while the current week still needs work', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    const r = await w.step();
    expect(r.report).toMatchObject({ step: 'listing', expectedAuctionDate: EXPECTED });
    expect(r.report.catchUp).toBeUndefined();
    const r2 = await w.step();
    expect(r2.report).toMatchObject({ step: 'release', expectedAuctionDate: EXPECTED });
  });

  it('NC-C5: nothing older than the four-week window is looked for (a missing 26-08 is ignored)', async () => {
    const w = world(); // default history starts 02-09: 26-08 has no row but lies outside the window
    await finishCurrentWeek(w);
    const requests = w.calls.length;
    expect((await w.step()).report.step).toBe('complete');
    expect(w.calls.length).toBe(requests);
  });

  it('NC-C6: a dry run catch-up writes no rate and marks nothing done', async () => {
    const w = world({ observations: missingSep16, route: catchUpRoute });
    await finishCurrentWeek(w);
    const rpcBefore = w.rpc.mock.calls.length;
    await w.step({ dryRun: true });
    await w.step({ dryRun: true });
    const c = await w.step({ dryRun: true });
    expect(c.report).toMatchObject({ mode: 'dry_run', step: 'decide', catchUp: true, tbill: { outcome: 'publish' } });
    expect(c.report.tbill?.detail).toContain('Would publish');
    expect(w.rpc.mock.calls.length).toBe(rpcBefore);
    expect(w.store.rows.get(SEP16)?.decidedLiveAt).toBeNull();
  });
});

describe('the alert e-mail', () => {
  const mailer = (impl?: (mail: OutgoingMail) => Promise<{ ok: boolean }>) => {
    const send = vi.fn(impl ?? (async (_mail: OutgoingMail) => ({ ok: true })));
    return { send, alert: { mailer: { configured: () => true, from: () => 'FHIP <alerts@example.invalid>', send } as unknown as Mailer, to: 'owner@example.invalid' } };
  };
  const BIG = releaseHtml({ price: [priceFor(6.2).toFixed(4), '97.2000', '94.3000'], ytm: ['(YTM: 6.2000%)', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] }); // far from the stored 5.19
  const bigRoute: Route = (u, init) => (isRobots(u) ? html(UNAUTHORISED) : u.includes('prid=') ? html(BIG) : u.includes('NSDP') ? html(NSDP) : init.method === 'POST' || u.startsWith(RBI_LISTING_URL) ? html(LISTING) : html(NSDP));
  const SAT_BEFORE = { today: '2026-10-03', nowIso: '2026-10-03T03:30:00.000Z' };
  const SAT_AFTER = { today: '2026-10-03', nowIso: '2026-10-03T03:45:00.000Z' };
  const noRelease: Route = (u) => (isRobots(u) ? html(UNAUTHORISED) : html(listingHtml([])));

  it('NC-A1: a result sent to review is e-mailed ONCE, with dd-mm-yyyy dates and the reason codes, and only when the review item is NEW', async () => {
    const w = world({ route: bigRoute });
    const m = mailer();
    await w.step({ alert: m.alert });
    await w.step({ alert: m.alert });
    const r = await w.step({ alert: m.alert });
    expect(r.report.tbill).toMatchObject({ outcome: 'review', reasons: ['outside_plausible_band'] });
    expect(r.report.mail).toBe('sent');
    expect(m.send).toHaveBeenCalledTimes(1);
    const mail = m.send.mock.calls[0][0] as { to: string; subject: string; text: string; idempotencyKey: string };
    expect(mail.to).toBe('owner@example.invalid');
    expect(mail.subject + mail.text).toContain('30-09-2026');
    expect(mail.subject + mail.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(mail.text).toContain('outside_plausible_band');
    expect(mail.idempotencyKey).toBe('risk-free-refresh-needs_review-2026-09-30');

    // the same case again: the database already holds that open item (queued 0), so no second e-mail
    const w2 = world({ route: bigRoute });
    const m2 = mailer();
    w2.rpc.mockImplementation(async () => ({ data: { batch_id: 'b', inserted: 0, identical: 0, queued: 0, name: 'record_risk_free_refresh_results' }, error: null }));
    await w2.step({ alert: m2.alert });
    await w2.step({ alert: m2.alert });
    const again = await w2.step({ alert: m2.alert });
    expect(again.report.tbill?.outcome).toBe('review');
    expect(m2.send).not.toHaveBeenCalled();
    expect(again.report.mail).toBeUndefined();
  });

  it('NC-A1: a result that PUBLISHES sends nothing', async () => {
    const w = world();
    const m = mailer();
    for (let i = 0; i < 3; i += 1) await w.step({ alert: m.alert });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('NC-A2: a refusal by RBI is e-mailed once; the waiting calls and the next windows send nothing more', async () => {
    const w = world({ route: (u) => (isRobots(u) ? html(UNAUTHORISED) : html('forbidden', 403)) });
    const m = mailer();
    const r = await w.step({ alert: m.alert });
    expect(r.report).toMatchObject({ sourceStatus: 'blocked_by_source', mail: 'sent' });
    expect(m.send).toHaveBeenCalledTimes(1);
    const mail = m.send.mock.calls[0][0] as { subject: string; text: string };
    expect(mail.subject).toContain('refused a page');
    expect(mail.text).toContain('30-09-2026');
    w.advanceMinutes(5);
    await w.step({ alert: m.alert });
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it('NC-A3: a week still not loaded after the Saturday retry is recorded as a review item and e-mailed once', async () => {
    const w = world({ route: noRelease });
    const m = mailer();
    const r = await w.step({ ...SAT_AFTER, alert: m.alert });
    expect(r.report.mail).toBe('sent');
    expect(m.send).toHaveBeenCalledTimes(1);
    const item = w.rpc.mock.calls.map((c) => c[1]).find((c) => Array.isArray(c.p_review_items) && (c.p_review_items as Array<{ reasons: string[] }>).some((i) => i.reasons.includes('week_not_loaded_after_retries')));
    expect(item).toBeTruthy();
    expect((item!.p_review_items as Array<{ observation_date: string }>)[0].observation_date).toBe(EXPECTED);
    const mail = m.send.mock.calls[0][0] as { subject: string; text: string };
    expect(mail.subject).toContain('30-09-2026');
    expect(mail.subject).toContain('still not loaded');
  });

  it('NC-A3: not before the deadline (Saturday 03:44 UTC), and never when the week is already stored', async () => {
    const early = world({ route: noRelease });
    const m1 = mailer();
    expect((await early.step({ ...SAT_BEFORE, alert: m1.alert })).report.mail).toBeUndefined();
    expect(m1.send).not.toHaveBeenCalled();
    const stored30 = world({ route: noRelease, observations: [stored('2026-09-02', 5.1), stored('2026-09-09', 5.15), stored('2026-09-16', 5.17), stored('2026-09-23', 5.19), stored('2026-09-30', 5.2), REPO_ROW] });
    const m2 = mailer();
    expect((await stored30.step({ ...SAT_AFTER, alert: m2.alert })).report.mail).toBeUndefined();
    expect(m2.send).not.toHaveBeenCalled();
  });

  it('NC-A3: the same missed week is not e-mailed twice (the database holds the open item)', async () => {
    const w = world({ route: noRelease });
    w.rpc.mockImplementation(async () => ({ data: { batch_id: 'b', inserted: 0, identical: 0, queued: 0, name: 'record_risk_free_refresh_results' }, error: null }));
    const m = mailer();
    expect((await w.step({ ...SAT_AFTER, alert: m.alert })).report.mail).toBeUndefined();
    expect(m.send).not.toHaveBeenCalled();
  });

  it('NC-A4: a dry run never sends and never records an alert item', async () => {
    const w = world({ route: noRelease });
    const m = mailer();
    const r = await w.step({ ...SAT_AFTER, dryRun: true, alert: m.alert });
    expect(r.report.mail).toBeUndefined();
    expect(m.send).not.toHaveBeenCalled();
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('NC-A4: with no recipient setting the case is still recorded and the answer says not_configured', async () => {
    const w = world({ route: noRelease });
    const r = await w.step({ ...SAT_AFTER, alert: null });
    expect(r.report.mail).toBe('not_configured');
    expect(w.rpc).toHaveBeenCalledTimes(1);
    const none = world({ route: noRelease });
    expect((await none.step({ ...SAT_AFTER })).report.mail).toBe('not_configured'); // the setting is absent altogether
  });

  it('NC-A4: a mail provider that fails, throws or never answers never changes the step answer', async () => {
    for (const impl of [async () => ({ ok: false }), async (): Promise<{ ok: boolean }> => { throw new Error('boom'); }]) {
      const w = world({ route: noRelease });
      const m = mailer(impl);
      const r = await w.step({ ...SAT_AFTER, alert: m.alert });
      expect(r.report.mail).toBe('failed');
      expect(r.report.step).toBe('listing');
    }
  });
});

describe('the alert e-mail text and sender (unit)', () => {
  const fixed = { configured: () => true, from: () => 'FHIP <a@example.invalid>' };

  it('every message carries the auction date as dd-mm-yyyy and no ISO date, no secret and no stored figure', () => {
    for (const kind of ['blocked', 'needs_review', 'week_not_loaded'] as const) {
      const m = buildRefreshAlert({ kind, auctionDate: '2026-11-18', reasons: kind === 'needs_review' ? ['nsdp_mismatch'] : undefined });
      const all = `${m.subject}\n${m.text}`;
      expect(all, kind).toContain('18-11-2026');
      expect(all, kind).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(all, kind).not.toMatch(/secret|password|token|undefined|null/i);
    }
    expect(buildRefreshAlert({ kind: 'needs_review', auctionDate: '2026-11-18', reasons: ['nsdp_mismatch'] }).text).toContain('nsdp_mismatch');
  });

  it('a call that has already used its time budget does not start a mail; a missing mailer or recipient is not_configured', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const mailer = { ...fixed, send } as unknown as Mailer;
    expect(await sendRefreshAlert({ mailer, to: 'o@example.invalid', alert: { kind: 'blocked', auctionDate: '2026-11-18' }, usedMs: 14_001 })).toBe('skipped_time');
    expect(await sendRefreshAlert({ mailer, to: '', alert: { kind: 'blocked', auctionDate: '2026-11-18' }, usedMs: 0 })).toBe('not_configured');
    expect(await sendRefreshAlert({ mailer: null, to: 'o@example.invalid', alert: { kind: 'blocked', auctionDate: '2026-11-18' }, usedMs: 0 })).toBe('not_configured');
    expect(await sendRefreshAlert({ mailer: { ...fixed, configured: () => false, send } as unknown as Mailer, to: 'o@example.invalid', alert: { kind: 'blocked', auctionDate: '2026-11-18' }, usedMs: 0 })).toBe('not_configured');
    expect(send).not.toHaveBeenCalled();
  });

  it('a provider that never answers is given up on after the timeout (the step is not held past the 28-second limit)', async () => {
    vi.useFakeTimers();
    try {
      const mailer = { ...fixed, send: () => new Promise(() => undefined) } as unknown as Mailer;
      const p = sendRefreshAlert({ mailer, to: 'o@example.invalid', alert: { kind: 'blocked', auctionDate: '2026-11-18' }, usedMs: 0 });
      await vi.advanceTimersByTimeAsync(ALERT_SEND_TIMEOUT_MS + 1);
      expect(await p).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a refusal while catching up stops EVERY auction (NC-C4, end to end)', () => {
  it('RBI refuses the listing of the newest missing week: the next call, which would otherwise start the next missing week, makes no request at all', async () => {
    // Two earlier weeks are missing (09-09 and 09-16). The current week finishes, then the catch-up on 09-16 is refused by RBI.
    const w = world({ observations: [stored('2026-09-02', 5.1), stored('2026-09-23', 5.19), REPO_ROW], route: catchUpRoute });
    await finishCurrentWeek(w);
    w.setRoute((u) => (isRobots(u) ? html(UNAUTHORISED) : html('forbidden', 403)));
    const refused = await w.step();
    expect(refused.report).toMatchObject({ step: 'listing', catchUp: true, expectedAuctionDate: SEP16, sourceStatus: 'blocked_by_source' });
    expect(w.store.rows.get(SEP16)?.evidence.refused).toBe(true); // the refusal is written on the row, which is what later calls read

    const requests = w.calls.length;
    w.advanceMinutes(5);
    w.setRoute(catchUpRoute); // RBI answers normally again, but the six hours are not over
    const next = await w.step();
    expect(next.report.step).toBe('waiting');
    expect(w.calls.length).toBe(requests); // the OTHER missing week (09-09) was not started either
    expect(w.store.rows.get('2026-09-09')).toBeUndefined();
  });
});
