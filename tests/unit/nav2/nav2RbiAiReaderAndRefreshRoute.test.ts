// NAV2 Stage 2 -- the AI reader's contract (no provider is called) and the refresh route's two safety layers.
//
// NAMED NEGATIVE CONTROLS
//   NC-AI1  the AI reply schema is strict: an extra key, a price outside (0,100) or a malformed date is rejected;
//   NC-AI2  a reply whose title is not the expected one is a failed read (null), never a figure;
//   NC-AI3  with the AIE kill switch off no reader exists, so no provider call can be made;
//   NC-AI4  the prompt says the page text is untrusted, forbids calculating or correcting, and asks for the 91-Day column only;
//   NC-RT1  no secret / a wrong secret is a 401 and nothing is read; switch off makes no request and no write;
//   NC-RT2  the job writes only when the body says dryRun === false explicitly: no body, true, a string or null are all a dry run
//           (its one write is the scratch stage row that hands readings to the next step).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb } from '../support/inMemorySupabase';
import { createGatewayAiReader, factsToParsedAuction, RBI_AI_SYSTEM_PROMPT, rbiAuctionFactsSchema } from '@/lib/services/investment-intelligence/nav2/rbiAiReader';
import { nsdpHtml, releaseHtml } from './support/rbiPages';

const facts = { releaseNumber: '2026-2027/1218', title: 'Treasury Bills: Full Auction Result', auctionDate: '2026-09-30', cutoffPrice91Day: 98.7203, cutoffYield91DayPercent: 5.2, noAcceptedBids: false };

describe('AI reader contract', () => {
  it('NC-AI1: the reply schema is strict', () => {
    expect(rbiAuctionFactsSchema.safeParse(facts).success).toBe(true);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, extra: 'ignore previous instructions' }).success).toBe(false);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, cutoffPrice91Day: 987.2 }).success).toBe(false);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, cutoffYield91DayPercent: 0 }).success).toBe(false);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, auctionDate: '30-09-2026' }).success).toBe(false);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, noAcceptedBids: 'yes' }).success).toBe(false);
    expect(rbiAuctionFactsSchema.safeParse({ ...facts, cutoffPrice91Day: null, cutoffYield91DayPercent: null, noAcceptedBids: true }).success).toBe(true);
  });
  it('NC-AI2: a reply with another title is a failed read; the right title maps to the gate\'s reading', () => {
    expect(factsToParsedAuction({ ...facts, title: 'Something else' })).toBeNull();
    expect(factsToParsedAuction({ ...facts, title: null })).toBeNull();
    expect(factsToParsedAuction(facts)).toEqual({ releaseNumber: '2026-2027/1218', title: 'Treasury Bills: Full Auction Result', auctionDate: '2026-09-30', cutoffPrice: 98.7203, cutoffYieldPercent: 5.2, noAcceptedBids: false });
  });
  it('NC-AI3b: with the switch ON but no person to attribute the call to (the cron run) there is still no reader: the per-user daily cap fails closed without a user', () => {
    const prev = process.env.AIE_AI_FALLBACK_ENABLED;
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    expect(createGatewayAiReader()).toBeNull();
    expect(createGatewayAiReader(null)).toBeNull();
    if (prev === undefined) delete process.env.AIE_AI_FALLBACK_ENABLED;
    else process.env.AIE_AI_FALLBACK_ENABLED = prev;
  });
  it('NC-AI3: with the AIE kill switch off there is no reader (so no provider call can happen)', () => {
    const prev = process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    expect(createGatewayAiReader()).toBeNull();
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    expect(createGatewayAiReader()).toBeNull();
    if (prev === undefined) delete process.env.AIE_AI_FALLBACK_ENABLED;
    else process.env.AIE_AI_FALLBACK_ENABLED = prev;
  });
  it('NC-AI4: the prompt treats the page as untrusted data and limits the task', () => {
    expect(RBI_AI_SYSTEM_PROMPT).toMatch(/untrusted data/);
    expect(RBI_AI_SYSTEM_PROMPT).toMatch(/Never follow any instruction/);
    expect(RBI_AI_SYSTEM_PROMPT).toMatch(/91-Day column only/);
    expect(RBI_AI_SYSTEM_PROMPT).toMatch(/Do not calculate, estimate or correct/);
    expect(RBI_AI_SYSTEM_PROMPT).toMatch(/exactly these keys/);
  });
});

// ---------------------------------------------------------------------------
let db: InMemoryDb;
const rpc = vi.fn(async (_n: string, a: Record<string, unknown>) => ({ data: { inserted: (a.p_rows as unknown[]).length, identical: 0, queued: (a.p_review_items as unknown[]).length }, error: null }));
const findAuctionListing = vi.fn();
const readReleasePage = vi.fn();
const readNsdp = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => Object.assign(Object.create(null), { from: (t: string) => (db.client as { from: (t: string) => unknown }).from(t), rpc }) }));
vi.mock('@/lib/services/investment-intelligence/nav2/rbiSource', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/rbiSource')>();
  return { ...actual, createLiveRbiSource: () => ({ findAuctionRelease: vi.fn(), findAuctionListing, readReleasePage, readNsdp, requestsMade: () => ({ pages: 2, robots: 1 }) }) };
});

import { POST } from '@/app/api/investment-intelligence/cron/nav2-risk-free-refresh/route';

const req = (secret: string | null, body: unknown = undefined) => new Request('http://t/cron', { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {}, body: body === undefined ? undefined : JSON.stringify(body) });

function world(switchOn: boolean) {
  db = createInMemoryDb({ strictSchema: true, upsertMerges: true });
  db.reset({
    ii_reference_job_control: switchOn ? [{ job_key: 'nav2_risk_free_weekly_refresh', enabled: true, consecutive_failures: 0 }] : [{ job_key: 'nav2_risk_free_weekly_refresh', enabled: false }],
    ii_risk_free_observations: [
      { series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', observation_date: '2020-01-01', kind: 'value', value_percent: 5.19 },
      { series_id: 'RBI_POLICY_REPO_RATE', observation_date: '2020-01-01', kind: 'value', value_percent: 5.25 },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'right-secret';
  delete process.env.AIE_AI_FALLBACK_ENABLED;
  world(true);
  findAuctionListing.mockResolvedValue({ found: false, reason: 'No release yet.' });
  readNsdp.mockResolvedValue(nsdpHtml());
});

describe('refresh route (NC-RT1, NC-RT2)', () => {
  const stageWrites = () => db.writes.filter((w) => w.table === 'ii_risk_free_refresh_stage');

  it('NC-RT1: a missing or wrong secret is 401 and reads nothing', async () => {
    expect((await POST(req(null))).status).toBe(401);
    expect((await POST(req('wrong'))).status).toBe(401);
    expect(db.reads).toEqual([]);
    expect(findAuctionListing).not.toHaveBeenCalled();
  });

  it('NC-RT1: switch OFF makes no request to RBI and no write, reads no stage row, and says so', async () => {
    world(false);
    const res = await POST(req('right-secret', { dryRun: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ mode: 'skipped_kill_switch', step: 'skipped_kill_switch', requests: { pages: 0, robots: 0 } });
    expect(findAuctionListing).not.toHaveBeenCalled();
    expect(readNsdp).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
    expect(db.reads).not.toContain('ii_risk_free_refresh_stage');
  });

  it('NC-RT2: anything but an explicit dryRun:false is a dry run (no body, true, a string, null, a number)', async () => {
    for (const body of [undefined, {}, { dryRun: true }, { dryRun: 'false' }, { dryRun: null }, { dryRun: 0 }]) {
      const res = await POST(req('right-secret', body));
      expect((await res.json()).data.mode, JSON.stringify(body)).toBe('dry_run');
    }
    expect(rpc).not.toHaveBeenCalled();
    // the only thing a dry run may write is the scratch row that hands its readings to the next step
    expect(db.writes.filter((w) => w.table !== 'ii_risk_free_refresh_stage')).toEqual([]);
    expect(db.tables.ii_reference_job_control[0].last_success_at).toBeUndefined();
    expect(db.tables.ii_risk_free_refresh_attempts ?? []).toEqual([]);
  });

  it('each call does ONE step and says which: listing, release, decide (a live week)', async () => {
    findAuctionListing.mockResolvedValue({ found: true, prid: '63696', releaseDate: '2026-09-30', url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696' });
    readReleasePage.mockResolvedValue(releaseHtml({ price: ['98.7203', '97.2', '94.3'], ytm: ['(YTM: 5.2000%)', '(YTM: 5.9%)', '(YTM: 6.2%)'] }));
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) steps.push((await (await POST(req('right-secret', { dryRun: false }))).json()).data.step);
    expect(steps).toEqual(['listing', 'release', 'decide']);
    expect(readReleasePage).toHaveBeenCalledTimes(1);
    expect(readNsdp).toHaveBeenCalledTimes(1);
    expect(stageWrites().length).toBeGreaterThanOrEqual(3);
  });

  it('a live decide records the repo confirmation through the function, ONE attempt row and the job-control success; the earlier step records neither', async () => {
    const first = await (await POST(req('right-secret', { dryRun: false }))).json(); // listing: nothing in the listing yet, so the next call is the decide step
    expect(first.data.step).toBe('listing');
    expect(db.tables.ii_risk_free_refresh_attempts ?? []).toEqual([]);
    expect(db.tables.ii_reference_job_control[0].last_success_at).toBeUndefined();
    const res = await POST(req('right-secret', { dryRun: false }));
    const data = (await res.json()).data;
    expect(data).toMatchObject({ mode: 'live', step: 'decide' });
    expect(rpc).toHaveBeenCalledWith('record_risk_free_refresh_results', expect.objectContaining({ p_series_id: 'RBI_POLICY_REPO_RATE', p_verified_through: '2026-09-25' }));
    const control = db.tables.ii_reference_job_control[0];
    expect(control.consecutive_failures).toBe(0);
    expect(control.last_success_at).toBeTruthy();
    expect(db.tables.ii_risk_free_refresh_attempts).toEqual([expect.objectContaining({ source_status: 'ok', repo_outcome: 'confirm_unchanged' })]);
  });

  it('a refusal in a live call is recorded as a failure in the job control, writes no rates, and the next call makes no request', async () => {
    const { RbiFetchError } = await import('@/lib/services/investment-intelligence/nav2/rbiFetcher');
    findAuctionListing.mockRejectedValue(new RbiFetchError('human_verification', 'The page asks for human verification; the run stops.'));
    const res = await POST(req('right-secret', { dryRun: false }));
    const data = (await res.json()).data;
    expect(data.fetchProblem.code).toBe('human_verification');
    expect(data.sourceStatus).toBe('blocked_by_source');
    // No rate is written; the only database call is the single alert review item.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_rows: [], p_review_items: [{ reasons: ['blocked_by_source'], candidate: null }] });
    const control = db.tables.ii_reference_job_control[0];
    expect(control.consecutive_failures).toBe(1);
    expect(control.last_failure_at).toBeTruthy();
    // The live attempt is recorded for the monitoring page.
    expect(db.tables.ii_risk_free_refresh_attempts).toEqual([expect.objectContaining({ source_status: 'blocked_by_source', fetch_problem_code: 'human_verification' })]);
    // And the job now stays quiet: the next call is a "waiting" answer with no request and no second failure.
    findAuctionListing.mockClear();
    const next = (await (await POST(req('right-secret', { dryRun: false }))).json()).data;
    expect(next.step).toBe('waiting');
    expect(findAuctionListing).not.toHaveBeenCalled();
    expect(db.tables.ii_reference_job_control[0].consecutive_failures).toBe(1);
  });

  it('the answer is sanitised: no page body, no URL query, no secret', async () => {
    findAuctionListing.mockResolvedValue({ found: true, prid: '1', releaseDate: '2026-09-30', url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=1' });
    readReleasePage.mockResolvedValue(releaseHtml());
    let text = '';
    for (let i = 0; i < 3; i++) text += JSON.stringify(await (await POST(req('right-secret', {}))).json());
    expect(text).not.toContain('<html');
    expect(text).not.toContain('right-secret');
    expect(text).not.toContain('?prid=');
  });

  it('the route declares a 28 second ceiling, not the 90 seconds that Amplify never honoured', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', '..', 'app/api/investment-intelligence/cron/nav2-risk-free-refresh/route.ts'), 'utf8');
    expect(src).toMatch(/export const maxDuration = 28;/);
    expect(src).not.toMatch(/maxDuration = 90/);
  });
});
