// NAV2 Stage 2 -- the weekly risk-free refresh job, end to end over fake pages and an in-memory database.
//
// Matrix: Stage 2 row S2-30, in nine parts: kill switch off = no request, no write; dry run decides and writes nothing; publish only
// on the gate's say-so, with provenance; disagreement / single read / no NSDP / conflict -> review with evidence, nothing published;
// a gap row for no accepted bids; a late release writes nothing and is retried; idempotent; repo: unchanged advances the verified-
// through date and a change is only a review item; a fetch problem stops the run and writes nothing.
//
// NAMED NEGATIVE CONTROLS
//   NC-J1  with the switch off the source is never called and the database function is never called;
//   NC-J2  a dry run never calls the database function, whatever it decides;
//   NC-J3  parser and AI disagreeing publishes NOTHING; a parser-only read with no NSDP match publishes NOTHING;
//   NC-J4  a different value for an already-stored date is queued for review and never overwritten;
//   NC-J5  a listing date that differs from the page's own date makes the parser untrusted;
//   NC-J6  a repo rate that differs on NSDP never produces a row by itself.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParsedAuction } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { RbiFetchError } from '@/lib/services/investment-intelligence/nav2/rbiFetcher';
import type { AiAuctionReader } from '@/lib/services/investment-intelligence/nav2/rbiAiReader';
import type { RbiSource } from '@/lib/services/investment-intelligence/nav2/rbiSource';
import { latestWednesdayOnOrBefore, runRiskFreeRefresh, REPO_SERIES, TBILL_SERIES } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshJob';
import { createInMemoryDb, type Row } from '../support/inMemorySupabase';
import { nsdpHtml, releaseHtml } from './support/rbiPages';

const TODAY = '2026-10-02'; // a Friday; the expected auction is Wednesday 30-09-2026
const EXPECTED = '2026-09-30';
const URL = 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63696';

const stored = (date: string, v: number, series = TBILL_SERIES): Row => ({ series_id: series, observation_date: date, kind: 'value', value_percent: v });

function world(over: { observations?: Row[]; release?: 'found' | 'missing' | 'throws'; releaseHtml?: string; releaseDate?: string; nsdp?: string | null; nsdpThrows?: boolean } = {}) {
  const db = createInMemoryDb();
  db.reset({ ii_risk_free_observations: over.observations ?? [stored('2026-09-23', 5.19), stored('2025-12-05', 5.25, REPO_SERIES)] });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: { batch_id: 'b', inserted: (args.p_rows as unknown[]).length, identical: 0, queued: (args.p_review_items as unknown[]).length, name }, error: null }));
  const admin = Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc }) as unknown as SupabaseClient;
  const findAuctionRelease = vi.fn(async () => {
    if (over.release === 'throws') throw new RbiFetchError('human_verification', 'The page asks for human verification; the run stops.');
    if (over.release === 'missing') return { found: false as const, reason: 'No release yet.' };
    return { found: true as const, prid: '63696', releaseDate: over.releaseDate ?? EXPECTED, url: URL, html: over.releaseHtml ?? releaseHtml({ price: ['98.7203', '97.2000', '94.3000'], ytm: ['(YTM: 5.2000%)', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] }) };
  });
  const readNsdp = vi.fn(async () => {
    if (over.nsdpThrows) throw new RbiFetchError('timeout', 'The request timed out.');
    return over.nsdp === undefined ? nsdpHtml({ yields: ['5.47', '5.26', '5.26', '5.21', '5.28', '5.20'] }) : over.nsdp;
  });
  const source: RbiSource = { findAuctionRelease, readNsdp, requestsMade: () => ({ pages: 3, robots: 1 }) };
  return { db, admin, rpc, source, findAuctionRelease, readNsdp };
}

const agreeing = (over: Partial<ParsedAuction> = {}): AiAuctionReader => ({ read: async () => ({ releaseNumber: '2026-2027/1218', title: 'Treasury Bills: Full Auction Result', auctionDate: EXPECTED, cutoffPrice: 98.7, cutoffYieldPercent: 5.2, noAcceptedBids: false, ...over }) });

const run = (w: ReturnType<typeof world>, o: Partial<{ enabled: boolean; dryRun: boolean; ai: AiAuctionReader | null }> = {}) =>
  runRiskFreeRefresh({ admin: w.admin, source: w.source, ai: o.ai === undefined ? null : o.ai, enabled: o.enabled ?? true, dryRun: o.dryRun ?? false, todayIso: TODAY });

describe('the expected auction', () => {
  it('is the latest Wednesday on or before today', () => {
    expect(latestWednesdayOnOrBefore('2026-10-02')).toBe('2026-09-30');
    expect(latestWednesdayOnOrBefore('2026-09-30')).toBe('2026-09-30');
    expect(latestWednesdayOnOrBefore('2026-10-01')).toBe('2026-09-30');
    expect(latestWednesdayOnOrBefore('2026-10-07')).toBe('2026-10-07');
    expect(latestWednesdayOnOrBefore('2026-10-06')).toBe('2026-09-30');
  });
});

describe('switch and dry run (NC-J1, NC-J2)', () => {
  it('switch OFF: no request to RBI, no database function, no read of stored data', async () => {
    const w = world();
    const r = await run(w, { enabled: false });
    expect(r.mode).toBe('skipped_kill_switch');
    expect(w.findAuctionRelease).not.toHaveBeenCalled();
    expect(w.readNsdp).not.toHaveBeenCalled();
    expect(w.rpc).not.toHaveBeenCalled();
    expect(w.db.reads).toEqual([]);
  });

  it('dry run: reads and decides (it says what it WOULD publish) but never calls the database function', async () => {
    const w = world();
    const r = await run(w, { dryRun: true, ai: agreeing() });
    expect(r.mode).toBe('dry_run');
    expect(r.tbill).toMatchObject({ outcome: 'publish', auctionDate: EXPECTED, yieldPercent: 5.2 });
    expect(w.rpc).not.toHaveBeenCalled();
    expect(r.wrote).toEqual({ tbill: null, repo: null });
  });
});

describe('publication (matrix 73, 77)', () => {
  it('parser + AI agree and the NSDP matches: ONE function call publishes the row with its provenance, day-first source text and the release URL', async () => {
    const w = world();
    const r = await run(w, { ai: agreeing() });
    expect(r.tbill).toMatchObject({ outcome: 'publish' });
    const call = w.rpc.mock.calls.find((c) => c[1].p_series_id === TBILL_SERIES)!;
    expect(call[0]).toBe('record_risk_free_refresh_results');
    const row = (call[1].p_rows as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ date: EXPECTED, kind: 'value', value_percent: 5.2, retrieved_on: TODAY, source_url: URL });
    expect(String(row.source_document)).toContain('30-09-2026');
    expect(String(row.source_document)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(row.extraction).toMatchObject({ method: 'parser+ai', pressReleaseNumber: '2026-2027/1218' });
    expect((row.extraction as { checksPassed: string[] }).checksPassed).toEqual(expect.arrayContaining(['parser_ai_agreement', 'price_recompute', 'nsdp_cross_check', 'auction_date']));
    expect(call[1].p_review_items).toEqual([]);
    expect(r.wrote.tbill).toMatchObject({ inserted: 1, queued: 0 });
    expect(r.requests).toEqual({ pages: 3, robots: 1 });
  });

  it('parser alone WITH a matching NSDP publishes (method parser); the fetch budget the source reports is carried in the report', async () => {
    const w = world();
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'publish' });
    expect((w.rpc.mock.calls.find((c) => c[1].p_series_id === TBILL_SERIES)![1].p_rows as Array<{ extraction: { method: string } }>)[0].extraction.method).toBe('parser');
  });

  it('idempotent: a value already stored for that date is a no-op (no T-bill call at all)', async () => {
    const w = world({ observations: [stored('2026-09-23', 5.19), stored(EXPECTED, 5.2), stored('2025-12-05', 5.25, REPO_SERIES)] });
    const r = await run(w);
    // the stored series already reaches the expected auction, so nothing was even fetched for it
    expect(r.tbill?.outcome).toBe('up_to_date');
    expect(w.findAuctionRelease).not.toHaveBeenCalled();
    expect(w.rpc.mock.calls.some((c) => c[1].p_series_id === TBILL_SERIES)).toBe(false);
  });
});

describe('review, never a guess (matrix 74, NC-J3, NC-J4, NC-J5)', () => {
  const tbillCall = (w: ReturnType<typeof world>) => w.rpc.mock.calls.find((c) => c[1].p_series_id === TBILL_SERIES);

  it('NC-J3: parser and AI disagreeing publishes NOTHING and queues a review item with both readings as evidence', async () => {
    const w = world();
    const r = await run(w, { ai: agreeing({ cutoffYieldPercent: 5.21 }) });
    expect(r.tbill).toMatchObject({ outcome: 'review', reasons: ['parser_ai_disagree'] });
    const call = tbillCall(w)!;
    expect(call[1].p_rows).toEqual([]);
    const item = (call[1].p_review_items as Array<Record<string, unknown>>)[0];
    expect(item.reasons).toEqual(['parser_ai_disagree']);
    expect(item.observation_date).toBe(EXPECTED);
    expect(item.evidence).toMatchObject({ parser: { cutoffYieldPercent: 5.2 }, ai: { cutoffYieldPercent: 5.21 } });
    expect((item.candidate as { value_percent: number }).value_percent).toBe(5.2); // so an admin can accept it knowingly
  });

  it('NC-J3: a parser-only read with NO NSDP page publishes NOTHING (a single read needs the cross-check)', async () => {
    const w = world({ nsdp: null });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'review' });
    expect(r.tbill?.reasons).toContain('single_read_needs_nsdp_match');
    expect(tbillCall(w)![1].p_rows).toEqual([]);
  });

  it('an NSDP value that does not match is a review item (nsdp_mismatch) even with two agreeing reads', async () => {
    const w = world({ nsdp: nsdpHtml({ yields: ['5.47', '5.26', '5.26', '5.21', '5.28', '5.33'] }) });
    const r = await run(w, { ai: agreeing() });
    expect(r.tbill).toMatchObject({ outcome: 'review' });
    expect(r.tbill?.reasons).toContain('nsdp_mismatch');
    expect(tbillCall(w)![1].p_rows).toEqual([]);
  });

  it('a layout change (parser null) with no AI and no NSDP match is a review item with no candidate; with the AI it still needs the NSDP match', async () => {
    const w = world({ releaseHtml: '<html><body>Layout changed completely</body></html>' });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'review', reasons: ['parser_failed_and_ai_unavailable'] });
    const item = (tbillCall(w)![1].p_review_items as Array<Record<string, unknown>>)[0];
    expect(item.candidate).toBeNull();
    const w2 = world({ releaseHtml: '<html><body>Layout changed completely</body></html>', nsdp: null });
    const r2 = await run(w2, { ai: agreeing() });
    expect(r2.tbill?.outcome).toBe('review');
    expect(tbillCall(w2)![1].p_rows).toEqual([]);
  });

  it('NC-J5: a listing date that differs from the page\'s own date makes the parser untrusted', async () => {
    const w = world({ releaseDate: '2026-10-01' });
    const r = await run(w);
    expect(r.tbill?.outcome).toBe('review'); // parser treated as failed, no AI -> parser_failed_and_ai_unavailable
    expect(tbillCall(w)![1].p_rows).toEqual([]);
  });

  it('NC-J4: a GAP already stored for that date, with a value now on the release, goes to review and nothing is overwritten', async () => {
    const w = world({ observations: [stored('2026-09-23', 5.19), stored('2025-12-05', 5.25, REPO_SERIES)] });
    w.db.tables.ii_risk_free_observations.push({ series_id: TBILL_SERIES, observation_date: EXPECTED, kind: 'gap', value_percent: null });
    const r = await run(w, { ai: agreeing() });
    expect(r.tbill).toMatchObject({ outcome: 'review', reasons: ['conflicts_with_stored_value'] });
    expect(tbillCall(w)![1].p_rows).toEqual([]);
    expect((tbillCall(w)![1].p_review_items as unknown[]).length).toBe(1);
  });

  it('a weekday outside the plausible week-on-week band is not published', async () => {
    const w = world({ observations: [stored('2026-09-23', 4.2), stored('2025-12-05', 5.25, REPO_SERIES)] });
    const r = await run(w, { ai: agreeing() });
    expect(r.tbill?.reasons).toContain('outside_plausible_band');
    expect(tbillCall(w)![1].p_rows).toEqual([]);
  });
});

describe('gap, late release, fetch problems (matrix 75, 76, 79)', () => {
  it('no accepted bids records a GAP row (no value) when the gate agrees', async () => {
    const w = world({ releaseHtml: releaseHtml({ price: ['-', '97.2000', '94.3000'], ytm: ['-', '(YTM: 5.9000%)', '(YTM: 6.2000%)'] }) });
    const r = await run(w, { ai: agreeing({ cutoffPrice: null, cutoffYieldPercent: null, noAcceptedBids: true }) });
    expect(r.tbill).toMatchObject({ outcome: 'record_gap' });
    const row = (w.rpc.mock.calls.find((c) => c[1].p_series_id === TBILL_SERIES)![1].p_rows as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ date: EXPECTED, kind: 'gap', value_percent: null, gap_reason: 'no_accepted_bids' });
  });

  it('a release that is not published yet writes nothing and says it will try again', async () => {
    const w = world({ release: 'missing' });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'no_release_yet' });
    expect(w.rpc.mock.calls.some((c) => c[1].p_series_id === TBILL_SERIES)).toBe(false);
  });

  it('a fetch problem (e.g. a verification page) stops the run, names the problem, and writes NOTHING', async () => {
    const w = world({ release: 'throws' });
    const r = await run(w);
    expect(r.fetchProblem).toEqual({ code: 'human_verification', message: expect.stringMatching(/verification/) });
    expect(r.tbill?.outcome).toBe('not_attempted');
    expect(w.rpc).not.toHaveBeenCalled();
    const w2 = world({ nsdpThrows: true });
    const r2 = await run(w2);
    expect(r2.fetchProblem?.code).toBe('timeout');
    expect(w2.rpc).not.toHaveBeenCalled();
  });
});

describe('the repo rate (matrix 78, NC-J6)', () => {
  const repoCall = (w: ReturnType<typeof world>) => w.rpc.mock.calls.find((c) => c[1].p_series_id === REPO_SERIES);

  it('an unchanged rate advances verified-through to the NSDP week and writes NO observation', async () => {
    const w = world();
    const r = await run(w);
    expect(r.repo).toMatchObject({ outcome: 'confirm_unchanged' });
    const call = repoCall(w)!;
    expect(call[1].p_verified_through).toBe('2026-09-25');
    expect(call[1].p_rows).toEqual([]);
    expect(call[1].p_review_items).toEqual([]);
  });

  it('NC-J6: a different NSDP rate is a review item with NO candidate row and no verified-through move', async () => {
    const w = world({ nsdp: nsdpHtml({ repo: ['5.50', '5.25', '5.25', '5.25', '5.25', '5.00'] }) });
    const r = await run(w);
    expect(r.repo).toMatchObject({ outcome: 'review' });
    const call = repoCall(w)!;
    expect(call[1].p_rows).toEqual([]);
    expect(call[1].p_verified_through).toBeNull();
    const item = (call[1].p_review_items as Array<Record<string, unknown>>)[0];
    expect(item.reasons).toEqual(['repo_change_without_policy_evidence']);
    expect(item.candidate).toBeNull();
  });

  it('no NSDP reading leaves the series neither confirmed nor changed (no repo call)', async () => {
    const w = world({ nsdp: null });
    const r = await run(w);
    expect(r.repo?.outcome).toBe('no_nsdp_reading');
    expect(repoCall(w)).toBeUndefined();
  });

  it('when the T-bill series is already current the NSDP page is still read (for the repo check) and no listing or release is fetched', async () => {
    const w = world({ observations: [stored(EXPECTED, 5.2), stored('2025-12-05', 5.25, REPO_SERIES)] });
    const r = await run(w);
    expect(w.findAuctionRelease).not.toHaveBeenCalled();
    expect(w.readNsdp).toHaveBeenCalledTimes(1);
    expect(r.repo?.outcome).toBe('confirm_unchanged');
  });
});
