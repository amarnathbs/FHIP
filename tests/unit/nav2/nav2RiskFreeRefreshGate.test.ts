// NAV2 Stage 1 -- the PUBLICATION GATE contract for the Stage 2 weekly risk-free
// refresh (PO decision 2026-10-03: automated read of RBI's HTML, parser first, AI
// as fallback and as an independent second opinion, publish only when every check
// passes, otherwise an admin review queue and NOTHING published).
//
// Stage 1 tests the DECISION: pure input readings -> outcome. The fetching, the HTML
// parser, the AI extraction and the writes are Stage 2; their fixtures (synthetic HTML
// built from the real release structure, never a committed RBI page) arrive with them.
// The readings below are SYNTHETIC. The cut-off prices are chosen so that the printed
// yield follows from the printed price on actual/365 over 91 days.
//
// NAMED NEGATIVE CONTROLS (the PO's list)
//   NC-A1  parser / AI disagreement never publishes (and never "picks one");
//   NC-A2  a yield that does not follow from the printed cut-off price never publishes;
//   NC-A3  the same week again writes nothing; a DIFFERENT value for a stored date is a review item, never an overwrite;
//   NC-A4  no accepted bids records a gap row and creates no value;
//   NC-A5  the kill switch off means no request at all; dry run writes nothing;
//   NC-A6  a repo change seen only on the NSDP page is never appended without policy evidence.
import { describe, expect, it } from 'vitest';
import {
  NSDP_PENDING_CHECK,
  RISK_FREE_REFRESH_FETCH_POLICY,
  RISK_FREE_REFRESH_RULES,
  daysOverdue,
  decideNsdpBackCheck,
  decideRepoRefresh,
  decideTbillRefresh,
  nsdpCoverage,
  planRefreshRun,
  recomputeYieldPercent,
  type NsdpReading,
  type ParsedAuction,
  type TbillRefreshInput,
} from '@/lib/engines/nav2/riskFreeRefreshGate';
import { expectClose } from './support/fixtures';

const auction = (over: Partial<ParsedAuction> = {}): ParsedAuction => ({
  releaseNumber: 'SYNTHETIC-2026-2027/1218',
  title: 'Treasury Bills: Full Auction Result',
  auctionDate: '2026-09-30', // a Wednesday
  cutoffPrice: 98.6425,
  cutoffYieldPercent: 5.5199,
  noAcceptedBids: false,
  ...over,
});
const NSDP_NONE: NsdpReading = { state: 'unavailable' };
const nsdp = (yield91dPercent: number | null, policyRepoPercent: number | null = 5.25, weekEnded = '2026-10-02'): NsdpReading => ({ state: 'value', weekEnded, yield91dPercent, policyRepoPercent });
const input = (over: Partial<TbillRefreshInput> = {}): TbillRefreshInput => ({
  releaseFound: true,
  parser: auction(),
  ai: auction(),
  nsdp: NSDP_NONE,
  lastStored: { observationDate: '2026-09-23', yieldPercent: 5.39 },
  storedOnDate: null,
  extractionVersion: 'parser-v1+ai-schema-v1',
  ...over,
});
/** The printed price that corresponds to a yield (actual/365, 91 days), rounded to RBI's 4 decimals. */
const priceFor = (y: number): number => Math.round((100 / (1 + (y / 100) * (91 / 365))) * 10000) / 10000;

describe('the yield recomputed from the printed cut-off price (spec of the PO\'s check b)', () => {
  it('yield = (100 - price) / price x 365 / 91 x 100; the first-load releases recompute to within 0.0002 percentage points', () => {
    expectClose(recomputeYieldPercent(98.6425), 5.519849539922036, 1e-12); // oracle (Python float): printed 5.5199
    expect(Math.abs(recomputeYieldPercent(98.6425) - 5.5199)).toBeLessThan(0.0002);
    expect(Math.abs(recomputeYieldPercent(98.674) - 5.39)).toBeLessThan(0.0002); // the 23-09-2026 release: price 98.6740, yield 5.3900
    expect(RISK_FREE_REFRESH_RULES.yieldRecomputeTolerancePp).toBe(0.001);
  });
});

describe('publish: every check passes', () => {
  it('parser and AI agree, the yield follows from the price, within the band, a Wednesday later than the stored date: PUBLISH with its provenance', () => {
    const r = decideTbillRefresh(input());
    expect(r.outcome).toBe('publish');
    if (r.outcome !== 'publish') throw new Error(r.outcome);
    expect(r).toMatchObject({ auctionDate: '2026-09-30', yieldPercent: 5.5199 });
    expect(r.extraction).toMatchObject({ pressReleaseNumber: 'SYNTHETIC-2026-2027/1218', method: 'parser+ai', version: 'parser-v1+ai-schema-v1' });
    expect(r.extraction.checksPassed).toEqual(['parser_ai_agreement', 'price_recompute', 'plausible_band', 'auction_date']);
    expect(r.checks).toEqual({ agreement: 'pass', priceRecompute: 'pass', plausibleBand: 'pass', nsdpCrossCheck: 'unavailable', auctionDate: 'pass' });
  });

  it('an NSDP value that matches at two decimals is added to the evidence', () => {
    const r = decideTbillRefresh(input({ nsdp: nsdp(5.52) }));
    if (r.outcome !== 'publish') throw new Error(r.outcome);
    expect(r.extraction.checksPassed).toContain('nsdp_cross_check');
  });

  it('the release has not been published (or was published late): no_release_yet, nothing else is decided', () => {
    const r = decideTbillRefresh(input({ releaseFound: false, parser: null, ai: null }));
    expect(r.outcome).toBe('no_release_yet');
    expect(JSON.stringify(r)).not.toMatch(/yieldPercent|publish/);
  });
});

describe('NC-A1: parser and AI disagreement never publishes', () => {
  it('different yield, different date, or one says no accepted bids: review (parser_ai_disagree), with both readings kept as evidence', () => {
    const cases: Array<Partial<TbillRefreshInput>> = [
      { ai: auction({ cutoffYieldPercent: 5.51, cutoffPrice: priceFor(5.51) }) },
      { ai: auction({ auctionDate: '2026-10-01' }) },
      { ai: auction({ noAcceptedBids: true, cutoffPrice: null, cutoffYieldPercent: null }) },
    ];
    for (const c of cases) {
      const r = decideTbillRefresh(input({ ...c, nsdp: nsdp(5.52) })); // even a MATCHING NSDP value cannot rescue a disagreement
      expect(r.outcome).toBe('review');
      if (r.outcome !== 'review') throw new Error(r.outcome);
      expect(r.reasons).toEqual(['parser_ai_disagree']);
      expect(r.checks.agreement).toBe('fail');
      expect(r.evidence.parser).not.toBeNull();
      expect(r.evidence.ai).not.toBeNull();
    }
  });

  it('control: the same readings with no disagreement DO publish (so the guard above is not vacuous)', () => {
    expect(decideTbillRefresh(input({ ai: auction() })).outcome).toBe('publish');
  });
});

describe('NC-A2: a yield that does not follow from the printed cut-off price never publishes', () => {
  it('both reads agree on a printed yield that the price does not support (a mis-read column): review (printed_yield_mismatch_with_price)', () => {
    const wrong = auction({ cutoffYieldPercent: 5.6199 }); // price 98.6425 supports 5.5199, not 5.6199
    const r = decideTbillRefresh(input({ parser: wrong, ai: wrong, nsdp: nsdp(5.62) }));
    expect(r.outcome).toBe('review');
    if (r.outcome !== 'review') throw new Error(r.outcome);
    expect(r.reasons).toContain('printed_yield_mismatch_with_price');
    expect(r.checks.priceRecompute).toBe('fail');
  });

  it('a missing cut-off price cannot be verified: review, never published on the yield alone', () => {
    const noPrice = auction({ cutoffPrice: null });
    const r = decideTbillRefresh(input({ parser: noPrice, ai: noPrice }));
    expect(r.outcome).toBe('review');
    expect(r.outcome === 'review' && r.reasons).toContain('cutoff_price_missing_cannot_recompute');
  });

  it('the tolerance is exactly 0.001 percentage points', () => {
    const justOk = auction({ cutoffYieldPercent: 5.5199 + 0.0009 });
    const justBad = auction({ cutoffYieldPercent: 5.5199 + 0.0012 });
    expect(decideTbillRefresh(input({ parser: justOk, ai: justOk })).outcome).toBe('publish');
    expect(decideTbillRefresh(input({ parser: justBad, ai: justBad })).outcome).toBe('review');
  });
});

describe('NC-A3: idempotent; a different value for a stored date is never an overwrite', () => {
  it('re-running the same week after it was published writes nothing (noop_duplicate)', () => {
    const r = decideTbillRefresh(input({ storedOnDate: { kind: 'value', yieldPercent: 5.5199 }, lastStored: { observationDate: '2026-09-30', yieldPercent: 5.5199 } }));
    expect(r).toEqual({ outcome: 'noop_duplicate', auctionDate: '2026-09-30' });
  });
  it('the stored date with a DIFFERENT value is a review item (conflicts_with_stored_value)', () => {
    const r = decideTbillRefresh(input({ storedOnDate: { kind: 'value', yieldPercent: 5.4 } }));
    expect(r.outcome).toBe('review');
    expect(r.outcome === 'review' && r.reasons).toEqual(['conflicts_with_stored_value']);
  });
});

describe('NC-A4: no accepted bids records a gap row and never a value', () => {
  const none = auction({ cutoffPrice: null, cutoffYieldPercent: null, noAcceptedBids: true });
  it('both reads agree there were no accepted bids: record_gap (no_accepted_bids), with no yield anywhere in the outcome', () => {
    const r = decideTbillRefresh(input({ parser: none, ai: none }));
    expect(r.outcome).toBe('record_gap');
    if (r.outcome !== 'record_gap') throw new Error(r.outcome);
    expect(r.gapReason).toBe('no_accepted_bids');
    expect(r.auctionDate).toBe('2026-09-30');
    expect('yieldPercent' in r).toBe(false);
    expect(r.extraction.checksPassed).toEqual(['gap_row_no_value']);
  });
  it('the gap already stored is a noop; a stored VALUE for that date is a conflict; the parser alone saying so also records a gap, never a value', () => {
    expect(decideTbillRefresh(input({ parser: none, ai: none, storedOnDate: { kind: 'gap' } }))).toEqual({ outcome: 'noop_duplicate', auctionDate: '2026-09-30' });
    const c = decideTbillRefresh(input({ parser: none, ai: none, storedOnDate: { kind: 'value', yieldPercent: 5.5 } }));
    expect(c.outcome).toBe('review');
    const single = decideTbillRefresh(input({ parser: none, ai: null }));
    expect(single.outcome).toBe('record_gap');
  });
  it('Stage 2 hardening: a GAP stored for the date with a VALUE now on the release is a conflict (review), never an automatic replacement', () => {
    const r = decideTbillRefresh(input({ storedOnDate: { kind: 'gap' } }));
    expect(r).toMatchObject({ outcome: 'review', reasons: ['conflicts_with_stored_value'] });
  });
});

describe('plausibility, NSDP cross-check and the date rules', () => {
  it('a move beyond the 0.5 percentage-point band is not published automatically (outside_plausible_band)', () => {
    const big = auction({ cutoffYieldPercent: 6.0, cutoffPrice: priceFor(6.0) });
    const r = decideTbillRefresh(input({ parser: big, ai: big, nsdp: nsdp(6.0) }));
    expect(r.outcome).toBe('review');
    expect(r.outcome === 'review' && r.reasons).toEqual(['outside_plausible_band']);
    // a move just inside the band publishes
    const ok = auction({ cutoffYieldPercent: 5.85, cutoffPrice: priceFor(5.85) });
    expect(decideTbillRefresh(input({ parser: ok, ai: ok })).outcome).toBe('publish');
  });

  it('an NSDP value that disagrees at two decimals blocks publication even when both reads agree and the price recomputes (nsdp_mismatch)', () => {
    const r = decideTbillRefresh(input({ nsdp: nsdp(5.31) }));
    expect(r.outcome).toBe('review');
    expect(r.outcome === 'review' && r.reasons).toEqual(['nsdp_mismatch']);
  });

  it('a single read (AI unavailable, or parser failed) publishes only with an NSDP match; without it, review', () => {
    expect(decideTbillRefresh(input({ ai: null })).outcome).toBe('review');
    expect(decideTbillRefresh(input({ ai: null, nsdp: nsdp(5.52) })).outcome).toBe('publish');
    const parserDown = decideTbillRefresh(input({ parser: null }));
    expect(parserDown.outcome === 'review' && parserDown.reasons).toContain('single_read_needs_nsdp_match');
    const aiOnly = decideTbillRefresh(input({ parser: null, nsdp: nsdp(5.52) }));
    if (aiOnly.outcome !== 'publish') throw new Error(aiOnly.outcome);
    expect(aiOnly.extraction.method).toBe('ai');
  });

  it('both reads failing (a layout change) is a review item with no guess', () => {
    const r = decideTbillRefresh(input({ parser: null, ai: null }));
    expect(r.outcome).toBe('review');
    expect(r.outcome === 'review' && r.reasons).toEqual(['parser_failed_and_ai_unavailable']);
  });

  it('the date must be a weekday and later than the last stored one', () => {
    const sat = auction({ auctionDate: '2026-10-03' }); // a Saturday
    expect(decideTbillRefresh(input({ parser: sat, ai: sat })).outcome === 'review' && (decideTbillRefresh(input({ parser: sat, ai: sat })) as { reasons: string[] }).reasons).toContain('auction_date_not_a_weekday');
    const old = auction({ auctionDate: '2026-09-16' });
    const r = decideTbillRefresh(input({ parser: old, ai: old }));
    expect(r.outcome === 'review' && r.reasons).toContain('auction_date_not_later_than_stored');
    expect(decideTbillRefresh(input({ parser: auction({ auctionDate: '' }), ai: auction({ auctionDate: '' }) })).outcome).toBe('review');
  });

  it('a Thursday (holiday-shifted) auction needs the NSDP match as well; the first-load data has one (27-08-2026)', () => {
    const thu = auction({ auctionDate: '2026-08-27', cutoffYieldPercent: 5.264, cutoffPrice: priceFor(5.264) });
    const last = { observationDate: '2026-08-19', yieldPercent: 5.2603 };
    const without = decideTbillRefresh(input({ parser: thu, ai: thu, lastStored: last }));
    expect(without.outcome).toBe('review');
    expect(without.outcome === 'review' && without.reasons).toEqual(['non_wednesday_needs_nsdp_match']);
    expect(decideTbillRefresh(input({ parser: thu, ai: thu, lastStored: last, nsdp: nsdp(5.26, 5.25, '2026-08-28') })).outcome).toBe('publish');
  });

  it('with no previous observation there is no band to check: the NSDP match is required', () => {
    const r = decideTbillRefresh(input({ lastStored: null }));
    expect(r.outcome === 'review' && r.reasons).toEqual(['no_previous_observation_needs_nsdp_match']);
    expect(decideTbillRefresh(input({ lastStored: null, nsdp: nsdp(5.52) })).outcome).toBe('publish');
  });
});

describe('repo rate: change detection needs policy evidence (NC-A6)', () => {
  const stored = { effectiveDate: '2025-12-05', ratePercent: 5.25 };
  const base = { stored, policyEvidence: null, adminConfirmed: null, todayIso: '2026-10-03' };

  it('unchanged: the verified-through date advances to the NSDP week and NO observation is written', () => {
    const r = decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.25, '2026-09-25') });
    expect(r).toMatchObject({ outcome: 'confirm_unchanged', verifiedThroughDate: '2026-09-25' });
    expect('ratePercent' in r).toBe(false);
  });

  it('no NSDP reading: neither confirmed nor changed; the verified-through date does not move', () => {
    expect(decideRepoRefresh({ ...base, nsdp: NSDP_NONE }).outcome).toBe('no_nsdp_reading');
    expect(decideRepoRefresh({ ...base, nsdp: nsdp(5.39, null) }).outcome).toBe('no_nsdp_reading');
  });

  it('NC-A6: NSDP shows a DIFFERENT rate but there is no policy evidence: review, nothing appended', () => {
    const r = decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0) });
    expect(r).toEqual({ outcome: 'review', reason: 'repo_change_without_policy_evidence' });
  });

  it('a change with the monetary-policy press release as evidence (agreeing with NSDP, effective after the stored date) is appended', () => {
    const r = decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0), policyEvidence: { repoPercent: 5.0, effectiveDate: '2026-10-02', document: 'SYNTHETIC monetary policy statement', url: null } });
    expect(r).toEqual({ outcome: 'publish_new_row', effectiveDate: '2026-10-02', ratePercent: 5.0, basis: 'policy_press_release' });
  });

  it('evidence that disagrees with NSDP, is not later than the stored date, or is dated in the future is a review item; an admin confirmation is the manual path', () => {
    const ev = (repoPercent: number, effectiveDate: string) => ({ repoPercent, effectiveDate, document: 'SYNTHETIC', url: null });
    expect(decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0), policyEvidence: ev(5.5, '2026-10-02') })).toEqual({ outcome: 'review', reason: 'evidence_disagrees_with_nsdp' });
    expect(decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0), policyEvidence: ev(5.0, '2025-12-05') })).toEqual({ outcome: 'review', reason: 'evidence_date_not_after_stored' });
    expect(decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0), policyEvidence: ev(5.0, '2026-10-10') })).toEqual({ outcome: 'review', reason: 'evidence_date_in_future' });
    const admin = decideRepoRefresh({ ...base, nsdp: nsdp(5.39, 5.0), adminConfirmed: { repoPercent: 5.0, effectiveDate: '2026-10-02' } });
    expect(admin).toEqual({ outcome: 'publish_new_row', effectiveDate: '2026-10-02', ratePercent: 5.0, basis: 'admin_confirmation' });
    expect(decideRepoRefresh({ ...base, stored: null, nsdp: nsdp(5.39, 5.0) })).toEqual({ outcome: 'review', reason: 'no_stored_rate' });
  });
});

describe('run planning and politeness (NC-A5)', () => {
  it('kill switch off: ZERO requests and no writes, whatever else is set; dry run reads and decides but writes nothing; live may write', () => {
    expect(planRefreshRun({ enabled: false, dryRun: false })).toEqual({ mode: 'skipped_kill_switch', maxRequests: 0, mayWrite: false });
    expect(planRefreshRun({ enabled: false, dryRun: true })).toEqual({ mode: 'skipped_kill_switch', maxRequests: 0, mayWrite: false });
    expect(planRefreshRun({ enabled: true, dryRun: true })).toEqual({ mode: 'dry_run', maxRequests: 4, mayWrite: false });
    expect(planRefreshRun({ enabled: true, dryRun: false })).toEqual({ mode: 'live', maxRequests: 4, mayWrite: true });
  });

  it('the fetch policy is polite and bounded: at most 4 requests, 4 s apart, conditional, robots.txt honoured, hard caps, never a PDF or a human-verification bypass, a descriptive User-Agent', () => {
    const p = RISK_FREE_REFRESH_FETCH_POLICY;
    expect(p.maxRequestsPerRun).toBeLessThanOrEqual(4);
    expect(p.minSpacingMs).toBeGreaterThanOrEqual(4000);
    expect(p.conditionalRequests).toBe(true);
    expect(p.honourRobotsTxt).toBe(true);
    expect(p.maxResponseBytes).toBeLessThanOrEqual(1_000_000);
    expect(p.perRequestTimeoutMs).toBeLessThanOrEqual(15_000);
    expect(p.runDeadlineMs).toBeLessThanOrEqual(60_000);
    expect(p.allowPdf).toBe(false);
    expect(p.bypassHumanVerification).toBe(false);
    expect(p.userAgent).toMatch(/^FHIP-RiskFreeRefresh\//);
  });

  it('days overdue (for the late-release alert): zero until the expected Wednesday, then whole days', () => {
    expect(daysOverdue('2026-10-07', '2026-10-03')).toBe(0);
    expect(daysOverdue('2026-10-07', '2026-10-10')).toBe(3);
  });
});

// PO DECISION 13-11-2026 ("option A"): the weekly NSDP page runs about two weeks behind the auction, so it is compared ONLY when its week is the auction
// week. When it has not reached that week ("not_yet") the parser's reading publishes on the release's own checks, marked nsdp_pending, and is
// compared later (decideNsdpBackCheck). Found by the first real production dry run: auction 11-11-2026 (5.8681) against a page whose latest week
// ended 30-10-2026 was sent to review as nsdp_mismatch, every week, so nothing could ever publish.
//   NC-N1  not_yet publishes a parser-only read, marked nsdp_pending; the real production case publishes;
//   NC-N2  not_yet waives ONLY the page: every other check, and the "AI alone" and "later week" and "unreadable page" cases, still go to review;
//   NC-N3  a page that covers the week still decides: a mismatch blocks, even with the parser alone;
//   NC-N4  the back-check compares only the week the page shows, tolerates two decimals, and never changes anything itself.
describe('option A: the NSDP page is compared only when it covers the auction week', () => {
  const weekOf = (weekEnded: string, yield91d: number | null = 5.93): NsdpReading => ({ state: 'value', weekEnded, yield91dPercent: yield91d, policyRepoPercent: 5.5 });

  it('which week the page covers: the week ended 0 to 6 days after the auction; earlier = not yet; later = the page moved on; no yield = no reading', () => {
    expect(nsdpCoverage(weekOf('2026-11-13'), '2026-11-11')).toBe('covers'); // Wednesday auction, Friday week end
    expect(nsdpCoverage(weekOf('2026-11-11'), '2026-11-11')).toBe('covers'); // 0 days
    expect(nsdpCoverage(weekOf('2026-11-17'), '2026-11-11')).toBe('covers'); // 6 days
    expect(nsdpCoverage(weekOf('2026-11-18'), '2026-11-11')).toBe('later_week'); // 7 days
    expect(nsdpCoverage(weekOf('2026-11-10'), '2026-11-11')).toBe('not_yet'); // the day before
    expect(nsdpCoverage(weekOf('2026-10-30'), '2026-11-11')).toBe('not_yet'); // the production case
    expect(nsdpCoverage(weekOf('2026-11-13', null), '2026-11-11')).toBe('no_reading');
    expect(nsdpCoverage({ state: 'unavailable' }, '2026-11-11')).toBe('no_reading');
  });

  const production = auction({ releaseNumber: '2026-2027/1478', auctionDate: '2026-11-11', cutoffPrice: 98.5581, cutoffYieldPercent: 5.8681 });
  const productionInput = (over: Partial<TbillRefreshInput> = {}): TbillRefreshInput =>
    input({ parser: production, ai: null, nsdp: weekOf('2026-10-30'), lastStored: { observationDate: '2026-10-28', yieldPercent: 5.9337 }, ...over });

  it('NC-N1: the REAL production case (auction 11-11-2026 at 5.8681, the page at the week ended 30-10-2026, parser only) now publishes, marked nsdp_pending', () => {
    const r = decideTbillRefresh(productionInput());
    if (r.outcome !== 'publish') throw new Error(r.outcome === 'review' ? r.reasons.join(',') : r.outcome);
    expect(r).toMatchObject({ auctionDate: '2026-11-11', yieldPercent: 5.8681 });
    expect(r.extraction).toMatchObject({ method: 'parser', pressReleaseNumber: '2026-2027/1478' });
    expect(r.extraction.checksPassed).toEqual(['price_recompute', 'plausible_band', NSDP_PENDING_CHECK, 'auction_date']);
    expect(r.checks).toEqual({ agreement: 'unavailable', priceRecompute: 'pass', plausibleBand: 'pass', nsdpCrossCheck: 'not_yet', auctionDate: 'pass' });
  });

  it('NC-N1: the page does not matter when it is behind: a different figure on an EARLIER week is not a mismatch, an absent figure is not a block', () => {
    expect(decideTbillRefresh(productionInput({ nsdp: weekOf('2026-10-30', 5.5) })).outcome).toBe('publish');
    expect(decideTbillRefresh(productionInput({ nsdp: weekOf('2026-10-30', 5.87) })).outcome).toBe('publish');
  });

  it('NC-N2: "not yet" waives ONLY the page: a move beyond the band, a Thursday auction, no previous value, a price that does not follow, a missing price: all review', () => {
    const reasons = (i: TbillRefreshInput): string[] => {
      const r = decideTbillRefresh(i);
      if (r.outcome !== 'review') throw new Error(`expected review, got ${r.outcome}`);
      return r.reasons;
    };
    const big = auction({ ...production, cutoffYieldPercent: 6.6, cutoffPrice: priceFor(6.6) });
    expect(reasons(productionInput({ parser: big }))).toEqual(['outside_plausible_band']);
    const thursday = auction({ ...production, auctionDate: '2026-11-12' });
    expect(reasons(productionInput({ parser: thursday }))).toEqual(['non_wednesday_needs_nsdp_match']);
    expect(reasons(productionInput({ lastStored: null }))).toEqual(['no_previous_observation_needs_nsdp_match']);
    expect(reasons(productionInput({ parser: auction({ ...production, cutoffYieldPercent: 5.9681 }) }))).toContain('printed_yield_mismatch_with_price');
    expect(reasons(productionInput({ parser: auction({ ...production, cutoffPrice: null }) }))).toContain('cutoff_price_missing_cannot_recompute');
    expect(reasons(productionInput({ lastStored: { observationDate: '2026-11-18', yieldPercent: 5.9 } }))).toContain('auction_date_not_later_than_stored');
    const sat = auction({ ...production, auctionDate: '2026-11-14' });
    expect(reasons(productionInput({ parser: sat }))).toContain('auction_date_not_a_weekday');
  });

  it('NC-N2: a reading that is the AI\'s ALONE (the parser failed) still needs the NSDP match: "not yet" does not help it', () => {
    const r = decideTbillRefresh(productionInput({ parser: null, ai: production }));
    expect(r.outcome === 'review' && r.reasons).toEqual(['single_read_needs_nsdp_match']);
  });

  it('NC-N2: a page whose week is LATER than the auction, or that cannot be read, keeps the original rule (a single read needs the match): review', () => {
    const later = decideTbillRefresh(productionInput({ nsdp: weekOf('2026-11-27') }));
    expect(later.outcome === 'review' && later.reasons).toEqual(['single_read_needs_nsdp_match']);
    expect(later.outcome === 'review' && later.checks.nsdpCrossCheck).toBe('unavailable');
    const unreadable = decideTbillRefresh(productionInput({ nsdp: NSDP_NONE }));
    expect(unreadable.outcome === 'review' && unreadable.reasons).toEqual(['single_read_needs_nsdp_match']);
    const noYield = decideTbillRefresh(productionInput({ nsdp: weekOf('2026-10-30', null) }));
    expect(noYield.outcome === 'review' && noYield.checks.nsdpCrossCheck).toBe('unavailable');
  });

  it('NC-N2: parser + AI agreeing is unchanged: it publishes with a "not yet" page and is marked pending too', () => {
    const r = decideTbillRefresh(productionInput({ ai: production }));
    if (r.outcome !== 'publish') throw new Error(r.outcome);
    expect(r.extraction.method).toBe('parser+ai');
    expect(r.extraction.checksPassed).toEqual(['parser_ai_agreement', 'price_recompute', 'plausible_band', NSDP_PENDING_CHECK, 'auction_date']);
  });

  it('NC-N3: a page that DOES cover the auction week still decides: a mismatch blocks even a parser-only read, a match publishes without the mark', () => {
    const mismatch = decideTbillRefresh(productionInput({ nsdp: weekOf('2026-11-13', 5.93) }));
    expect(mismatch.outcome === 'review' && mismatch.reasons).toEqual(['nsdp_mismatch']);
    const match = decideTbillRefresh(productionInput({ nsdp: weekOf('2026-11-13', 5.87) }));
    if (match.outcome !== 'publish') throw new Error(match.outcome);
    expect(match.extraction.checksPassed).toContain('nsdp_cross_check');
    expect(match.extraction.checksPassed).not.toContain(NSDP_PENDING_CHECK);
  });

  describe('the back-check of a value published before the page reached its week', () => {
    const pending = [
      { observationDate: '2026-11-04', yieldPercent: 5.9337 },
      { observationDate: '2026-11-11', yieldPercent: 5.8681 },
    ];

    it('NC-N4: compares only the value whose week the page shows; two decimals match; the other week is left for its own turn', () => {
      const r = decideNsdpBackCheck(weekOf('2026-11-13', 5.87), pending);
      expect(r.checked).toBe(1);
      expect(r.matched).toEqual([{ observationDate: '2026-11-11', yieldPercent: 5.8681 }]);
      expect(r.mismatched).toEqual([]);
      const earlier = decideNsdpBackCheck(weekOf('2026-11-06', 5.93), pending);
      expect(earlier.checked).toBe(1);
      expect(earlier.matched.map((m) => m.observationDate)).toEqual(['2026-11-04']);
    });

    it('NC-N4: a difference at two decimals is returned with both figures and the week; nothing is changed (the function only reports)', () => {
      const r = decideNsdpBackCheck(weekOf('2026-11-13', 5.9), pending);
      expect(r.checked).toBe(1);
      expect(r.matched).toEqual([]);
      expect(r.mismatched).toEqual([{ observationDate: '2026-11-11', yieldPercent: 5.8681, nsdpYieldPercent: 5.9, nsdpWeekEnded: '2026-11-13' }]);
      expect(pending[1].yieldPercent).toBe(5.8681);
    });

    it('NC-N4: a page that cannot be read, shows no yield, or shows a week nobody is waiting for checks nothing', () => {
      expect(decideNsdpBackCheck({ state: 'unavailable' }, pending).checked).toBe(0);
      expect(decideNsdpBackCheck(weekOf('2026-11-13', null), pending).checked).toBe(0);
      expect(decideNsdpBackCheck(weekOf('2026-12-04', 5.9), pending).checked).toBe(0);
      expect(decideNsdpBackCheck(weekOf('2026-11-13', 5.87), []).checked).toBe(0);
    });
  });
});
