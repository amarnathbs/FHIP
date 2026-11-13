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
// PO decision 13-11-2026 (option A): the weekly page's 91-day figure is compared ONLY when its latest week is the auction's week. The default page of
// this file ends with the week ended 25-09-2026, a week BEFORE the 30-09 auction (the real situation: the page runs about two weeks behind). This page ends
// with the week ended 02-10-2026, which covers it.
const COVERING_NSDP = (last: string): string => nsdpHtml({ dates: ['Aug. 28', 'Sep. 4', 'Sep. 11', 'Sep. 18', 'Sep. 25', 'Oct. 2'], yields: ['5.47', '5.26', '5.26', '5.21', '5.28', last] });
/** A value published on the release's own checks before the weekly page reached its week. */
const pendingRow = (date: string, v: number): Row => ({ ...stored(date, v), entry_kind: 'weekly_refresh_job', extraction: { method: 'parser', checksPassed: ['price_recompute', 'plausible_band', 'nsdp_pending', 'auction_date'] } });

function world(over: { observations?: Row[]; release?: 'found' | 'missing' | 'throws'; releaseHtml?: string; releaseDate?: string; nsdp?: string | null; nsdpThrows?: boolean } = {}) {
  const db = createInMemoryDb({ strictSchema: true });
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
  // The one-request run uses findAuctionRelease; the listing and release halves belong to the staged run (nav2RiskFreeRefreshSteps.test.ts).
  const source: RbiSource = { findAuctionRelease, findAuctionListing: vi.fn(), readReleasePage: vi.fn(), readNsdp, requestsMade: () => ({ pages: 3, robots: 1 }) };
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
    const w = world({ nsdp: COVERING_NSDP('5.20') });
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
    const w = world({ nsdp: COVERING_NSDP('5.33') });
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
    // A block is LOUD: no rate row is written, but exactly one alert review item is queued (blocked_by_source), with no candidate.
    expect(r.sourceStatus).toBe('blocked_by_source');
    expect(w.rpc).toHaveBeenCalledTimes(1);
    expect(w.rpc.mock.calls[0][1]).toMatchObject({ p_series_id: TBILL_SERIES, p_rows: [], p_verified_through: null, p_review_items: [{ observation_date: null, reasons: ['blocked_by_source'], candidate: null }] });
    expect(r.wrote.alert).toBe(true);
    const w2 = world({ nsdpThrows: true });
    const r2 = await run(w2);
    expect(r2.fetchProblem?.code).toBe('timeout');
    expect(r2.sourceStatus).toBe('fetch_problem'); // an ordinary fetch problem is reported but is not a block: no alert item
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

// PO DECISION 13-11-2026 ("option A"). The first real production dry run found that the weekly page runs about two weeks BEHIND the auction (on Friday
// 13-11-2026 its latest week ended 30-10-2026), so every fresh auction was sent to review as nsdp_mismatch and nothing could ever publish.
//   NC-N1  a parser-only read is PUBLISHED when the page has not reached the auction week, marked nsdp_pending (and not nsdp_cross_check);
//   NC-N2  "not yet" waives only the page: no previous value, or a page whose week is LATER than the auction week, still go to review;
//   NC-N3  the later back-check compares ONLY marked values whose week the page now shows; a match changes nothing, a difference is a review item;
//   NC-N4  the back-check never changes a stored value, never fails the run, and a dry run reports it but writes nothing.
describe('option A: the weekly page runs behind the auction (PO decision 13-11-2026)', () => {
  const tbillCall = (w: ReturnType<typeof world>) => w.rpc.mock.calls.find((c) => c[1].p_series_id === TBILL_SERIES);
  const reviewsOf = (w: ReturnType<typeof world>) => (tbillCall(w)?.[1].p_review_items ?? []) as Array<Record<string, unknown>>;
  const rowsOf = (w: ReturnType<typeof world>) => (tbillCall(w)?.[1].p_rows ?? []) as Array<Record<string, unknown>>;
  const repoRow = stored('2025-12-05', 5.25, REPO_SERIES);

  it('NC-N1: a parser-only read with a page one week behind PUBLISHES, marked nsdp_pending and without the nsdp_cross_check mark', async () => {
    const w = world(); // default page: latest week ended 25-09-2026, the auction is 30-09-2026
    const r = await run(w); // no AI: the scheduled run has none
    expect(r.tbill).toMatchObject({ outcome: 'publish', auctionDate: EXPECTED, yieldPercent: 5.2 });
    const row = rowsOf(w)[0];
    expect(row).toMatchObject({ date: EXPECTED, kind: 'value', value_percent: 5.2 });
    expect(row.extraction).toMatchObject({ method: 'parser', checksPassed: ['price_recompute', 'plausible_band', 'nsdp_pending', 'auction_date'] });
    expect((row.extraction as { checksPassed: string[] }).checksPassed).not.toContain('nsdp_cross_check');
    expect(reviewsOf(w)).toEqual([]);
  });

  it('NC-N1: a dry run reaches the same decision and writes nothing', async () => {
    const w = world();
    const r = await run(w, { dryRun: true });
    expect(r.tbill).toMatchObject({ outcome: 'publish', yieldPercent: 5.2 });
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('control: when the page DOES cover the auction week, the match is recorded as nsdp_cross_check and the mark is not set', async () => {
    const w = world({ nsdp: COVERING_NSDP('5.20') });
    await run(w);
    const checks = (rowsOf(w)[0].extraction as { checksPassed: string[] }).checksPassed;
    expect(checks).toContain('nsdp_cross_check');
    expect(checks).not.toContain('nsdp_pending');
  });

  it('NC-N2: with no previous value there is no band, so "not yet" is NOT enough: review', async () => {
    const w = world({ observations: [repoRow] });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'review' });
    expect(r.tbill?.reasons).toContain('no_previous_observation_needs_nsdp_match');
    expect(rowsOf(w)).toEqual([]);
  });

  it('NC-N2: a page whose latest week is LATER than the auction week (it no longer shows that week) still sends a parser-only read to review', async () => {
    const w = world({ nsdp: nsdpHtml({ dates: ['Sep. 4', 'Sep. 11', 'Sep. 18', 'Sep. 25', 'Oct. 2', 'Oct. 16'], yields: ['5.26', '5.26', '5.21', '5.28', '5.20', '5.20'] }) });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'review' });
    expect(r.tbill?.reasons).toContain('single_read_needs_nsdp_match');
    expect(rowsOf(w)).toEqual([]);
  });

  it('NC-N2: a page that cannot be read at all still sends a parser-only read to review (a changed layout must not switch the cross-check off silently)', async () => {
    const w = world({ nsdp: null });
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'review' });
    expect(rowsOf(w)).toEqual([]);
  });

  it('NC-N3: a marked value whose week the page now shows and that MATCHES it: compared, nothing queued, nothing written for it', async () => {
    const w = world({ observations: [pendingRow('2026-09-23', 5.2), repoRow] }); // the page ends with the week ended 25-09-2026 at 5.20
    const r = await run(w);
    expect(r.backCheck).toMatchObject({ checked: 1, matched: 1, mismatched: 0 });
    expect(reviewsOf(w).filter((i) => (i.reasons as string[]).includes('nsdp_backcheck_mismatch'))).toEqual([]);
    expect(rowsOf(w).map((x) => x.date)).toEqual([EXPECTED]); // only the new week; the 23-09 value is not rewritten
  });

  it('NC-N3: a marked value that DIFFERS from the page is queued as a review item with both figures; the stored value is never changed', async () => {
    const w = world({ observations: [pendingRow('2026-09-23', 5.19), repoRow] });
    const r = await run(w);
    expect(r.backCheck).toMatchObject({ checked: 1, matched: 0, mismatched: 1 });
    const item = reviewsOf(w).find((i) => (i.reasons as string[]).includes('nsdp_backcheck_mismatch'))!;
    expect(item).toMatchObject({ observation_date: '2026-09-23', candidate: null });
    expect(item.evidence).toMatchObject({ stored: { observationDate: '2026-09-23', yieldPercent: 5.19 }, weeklyPage: { weekEnded: '2026-09-25', yield91dPercent: 5.2 } });
    expect(rowsOf(w).map((x) => x.date)).toEqual([EXPECTED]);
    expect(w.db.tables.ii_risk_free_observations.find((x) => x.observation_date === '2026-09-23')).toMatchObject({ value_percent: 5.19 });
  });

  it('NC-N3: only MARKED values are back-checked: a manual upload or a value already matched against the page is left alone', async () => {
    const matched: Row = { ...stored('2026-09-23', 5.19), entry_kind: 'weekly_refresh_job', extraction: { method: 'parser+ai', checksPassed: ['parser_ai_agreement', 'price_recompute', 'nsdp_cross_check', 'auction_date'] } };
    const manual: Row = { ...stored('2026-09-24', 5.19), entry_kind: 'admin_upload', extraction: null };
    const w = world({ observations: [matched, manual, repoRow] });
    const r = await run(w);
    expect(r.backCheck).toMatchObject({ checked: 0, matched: 0, mismatched: 0 });
    expect(reviewsOf(w)).toEqual([]);
  });

  it('NC-N3: a marked value of ANOTHER week is not compared with this page (its own week has to be the one shown)', async () => {
    const w = world({ observations: [pendingRow('2026-09-09', 5.1), repoRow] }); // the page week ended 25-09-2026: 09-09 belongs to the week ended 11-09
    const r = await run(w);
    expect(r.backCheck).toMatchObject({ checked: 0 });
    expect(reviewsOf(w)).toEqual([]);
  });

  it('NC-N4: a dry run reports the back-check difference but writes nothing', async () => {
    const w = world({ observations: [pendingRow('2026-09-23', 5.19), repoRow] });
    const r = await run(w, { dryRun: true });
    expect(r.backCheck).toMatchObject({ checked: 1, mismatched: 1 });
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it('NC-N4: when the stored rows cannot be read for the back-check the run still finishes and says the check did not run', async () => {
    const w = world();
    const original = (w.admin as unknown as { from: (t: string) => Record<string, unknown> }).from;
    (w.admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const chain = original.call(w.admin, t);
      if (t === 'ii_risk_free_observations') chain.gte = () => { throw new Error('read failed'); }; // only the back-check uses a date range on this table
      return chain;
    };
    const r = await run(w);
    expect(r.tbill).toMatchObject({ outcome: 'publish' });
    expect(r.backCheck).toMatchObject({ checked: 0, detail: expect.stringContaining('did not run') });
    expect(rowsOf(w).map((x) => x.date)).toEqual([EXPECTED]);
  });

  it('no weekly page read, no back-check line (nothing to compare with)', async () => {
    const w = world({ nsdp: null });
    const r = await run(w);
    expect(r.backCheck).toBeUndefined();
  });
});
