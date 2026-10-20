// NAV2 Stage 1 -- INVESTOR-EXPERIENCE results: Fixture C (user transactions,
// XIRR ONLY -- the PO removed time-based returns from the programme) and the
// pure parts of Fixture G (valuation and attribution), plus the separation of the
// two result families (spec 2).
//
// Fixture C (oracle section C): three SIPs of Rs 10,000 at NAV 100, 125, 80
// (100 + 80 + 125 units), a partial redemption of 100 units at NAV 110
// (Rs 11,000), 205 units left, NAV 120 on 05-01-2025 -> terminal Rs 24,600.
//
// Matrix rows: 28, 29, 31, 32, 33, 34 (pure part).
//
// NAMED NEGATIVE CONTROLS
//   NC-I1  XIRR signs: purchases are negative, redemptions and the terminal value positive; flipping
//          the purchase sign gives no root, not a plausible-looking number;
//   NC-I2  XIRR without a terminal valuation is NOT calculated (no figure), and all-same-sign flows
//          are not_applicable -- never a guessed rate;
//   NC-I3  scheme CAGR and the user's XIRR are different figures for the same fund, in different
//          result families, with different labels; neither family carries the other's key;
//   NC-I4  the statement value and the market-NAV value are labelled separately, and a redeemed
//          holding is exactly zero whatever any NAV says;
//   NC-I5  a joint holding is attributed once: 60 / 40 sums to 100%, never 200%.
import { describe, expect, it } from 'vitest';
import { valueHoldingAsOf } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { attributeByBasisPoints } from '@/lib/services/investment-intelligence/ownerAttribution';
import { computeHeldSchemeAnalytics } from '@/lib/engines/nav2/analyticsContract';
import { computeInvestorExperience, INVESTOR_XIRR_LABEL, SCHEME_CAGR_LABEL, SCHEME_VS_INVESTOR_EXPLANATION } from '@/lib/engines/nav2/investorExperience';
import { standardAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { cagr } from '@/lib/engines/nav2/schemeReturns';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { allStrings, buildSeries, ctxAud, ctxInr, expectClose, ISO_DATE_IN_TEXT } from './support/fixtures';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const FLOWS = [
  { date: utc('2024-01-05'), amount: -10000 },
  { date: utc('2024-02-05'), amount: -10000 },
  { date: utc('2024-03-05'), amount: -10000 },
  { date: utc('2024-06-05'), amount: 11000 },
];
const C_DATES = ['2024-01-05', '2024-02-05', '2024-03-05', '2024-06-05', '2025-01-05'];
const C_NAVS = [100, 125, 80, 110, 120];

function valuation() {
  return valueHoldingAsOf({
    statements: [{ asOfDate: '2024-03-05', units: 305, value: 24400 }], // 100 + 80 + 125 units at the statement date, NAV 80
    navs: C_DATES.map((date, i) => ({ date, price: C_NAVS[i], currencyCode: 'INR' })),
    asOfDate: '2025-01-05',
    unitMovements: [{ date: '2024-06-05', unitDelta: -100 }], // the partial redemption
    currencyCode: 'INR',
  });
}

describe('Fixture C -- XIRR, current value, invested amount, gain / loss', () => {
  const v = valuation();
  const ie = computeInvestorExperience({ instrumentId: 'inst-a', flows: FLOWS, valuation: v, asOfDate: '2025-01-05' }, ctxInr());

  it('current value = canonical units x latest eligible NAV, on that NAV\'s own date (matrix 32)', () => {
    expect(v.basis).toBe('market_nav');
    expect(v.units).toBe(205); // 100 + 80 + 125 - 100
    expect(v.marketValue).toBe(24600); // 205 x 120
    expect(v.navDate).toBe('2025-01-05');
    if (ie.currentValue.state !== 'available') throw new Error(ie.currentValue.state);
    expect(ie.currentValue.value).toMatchObject({ value: 24600, basis: 'market_nav', units: 205, nav: 120, navDate: '2025-01-05', statementValue: 24400, statementAsOfDate: '2024-03-05', statementSuperseded: true });
  });

  it('XIRR signs and terminal value (matrix 28): purchases negative, redemption and terminal positive; rate 0.2641093553074878', () => {
    if (ie.xirr.state !== 'available') throw new Error(ie.xirr.state);
    expect(ie.xirr.value.cashFlowCount).toBe(5); // 3 purchases + 1 redemption + the terminal value
    expect(ie.xirr.value.terminalValue).toBe(24600);
    expect(ie.xirr.value.terminalValueDate).toBe('2025-01-05');
    expect(ie.xirr.value.terminalBasis).toBe('market_nav');
    expect(ie.xirr.value.periodStart).toBe('2024-01-05');
    expect(ie.xirr.value.periodEnd).toBe('2025-01-05');
    expectClose(ie.xirr.value.rate, 0.26410935530748780, 1e-6); // oracle: pure 50-digit bisection; the engine solves to 1e-7 of scale
    expect(ie.xirr.value.label).toBe(INVESTOR_XIRR_LABEL);
    expect(ie.xirr.provenance.family).toBe('investor_experience');
    expect(ie.xirr.provenance.definitionVersion).toBe('xirr-newton-bisection-v1');
  });

  it('invested Rs 30,000, received Rs 11,000, gain = 24,600 + 11,000 - 30,000 = Rs 5,600', () => {
    if (ie.investedAmount.state !== 'available' || ie.gainLoss.state !== 'available') throw new Error('available expected');
    expect(ie.investedAmount.value).toEqual({ invested: 30000, received: 11000, firstInvestmentDate: '2024-01-05' });
    expect(ie.gainLoss.value).toEqual({ gainLoss: 5600, currentValue: 24600, invested: 30000, received: 11000 });
  });

  it('NC-I3 / matrix 31: the scheme CAGR for the same fund and period (19.95%) is a DIFFERENT number from the user\'s XIRR (26.41%), in a separate family', () => {
    const series = buildSeries(C_DATES, C_NAVS);
    const c = cagr(series, ctxInr(), '2024-01-05', '2025-01-05');
    if (c.state !== 'available' || ie.xirr.state !== 'available') throw new Error('available expected');
    expect(c.value.actualDays).toBe(366);
    expectClose(c.value.cagr, 0.19954727040918235, 1e-12); // oracle: 1.2^(365.2425/366) - 1
    expect(Math.abs(ie.xirr.value.rate - c.value.cagr)).toBeGreaterThan(0.06);
    expect(c.provenance.family).toBe('scheme_performance');
    expect(ie.xirr.provenance.family).toBe('investor_experience');
  });

  it('NC-I3: the two families share no key and carry different labels; the plain-language difference is attached', () => {
    const series = buildSeries(C_DATES, C_NAVS);
    const analytics = computeHeldSchemeAnalytics(
      { series, spec: { ...standardAnalysisSpec('2025-01-05', NAV2_POLICY), pointToPoint: [{ id: 'since-first-purchase', start: '2024-01-05', end: '2025-01-05' }], rollingHorizonIds: [], movingAverages: [], rocPeriods: [], risk: false, benchmarkRelative: false }, ctx: ctxInr(), riskFree: null },
      { instrumentId: 'inst-a', flows: FLOWS, valuation: v, asOfDate: '2025-01-05' }
    );
    expect(analytics.scheme.family).toBe('scheme_performance');
    expect(analytics.investor?.family).toBe('investor_experience');
    expect(analytics.scheme.label).toBe(SCHEME_CAGR_LABEL);
    expect(analytics.investor?.label).toBe(INVESTOR_XIRR_LABEL);
    expect(analytics.explanation).toBe(SCHEME_VS_INVESTOR_EXPLANATION);
    const keys = (o: unknown, acc: string[] = []): string[] => {
      if (Array.isArray(o)) o.forEach((x) => keys(x, acc));
      else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { acc.push(k); keys(x, acc); }
      return acc;
    };
    const schemeKeys = keys(analytics.scheme);
    const investorKeys = keys(analytics.investor);
    expect(investorKeys).not.toContain('cagr');
    expect(schemeKeys).not.toContain('xirr');
    expect(schemeKeys).not.toContain('investedAmount');
    expect(schemeKeys).not.toContain('gainLoss');
    expect(analytics.explanation).toMatch(/usually differ/);
    // a scheme CAGR is labelled as the fund's own growth, never as "your" return
    expect(SCHEME_CAGR_LABEL).toMatch(/not your personal return/);
    expect(INVESTOR_XIRR_LABEL).toMatch(/your own money|Your return/i);
  });

  it('no time-based return anywhere in the investor family (PO decision): the result carries no such key or sentence', () => {
    const text = JSON.stringify(ie) + SCHEME_VS_INVESTOR_EXPLANATION + SCHEME_CAGR_LABEL + INVESTOR_XIRR_LABEL;
    expect(text).not.toMatch(/twrr|time[-_ ]?weighted|\btwr(?![a-z])/i);
  });
});

describe('XIRR failure is honest (matrix 29)', () => {
  it('NC-I2: with no valuation at all there is no XIRR and no value (insufficient_history), not a rate from the flows alone', () => {
    const none = valueHoldingAsOf({ statements: [], navs: [], asOfDate: '2025-01-05' });
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: FLOWS, valuation: none, asOfDate: '2025-01-05' }, ctxInr());
    expect(ie.xirr.state).toBe('insufficient_history');
    expect(ie.currentValue.state).toBe('insufficient_history');
    expect(ie.gainLoss.state).toBe('insufficient_history');
    expect('value' in ie.xirr).toBe(false);
  });

  it('NC-I2: purchases only and a redeemed holding (value 0) is all one sign: not_applicable, no rate', () => {
    const redeemed = valueHoldingAsOf({ statements: [{ asOfDate: '2024-03-05', units: 0, value: 0 }], navs: [], asOfDate: '2025-01-05' });
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: FLOWS.slice(0, 3), valuation: redeemed, asOfDate: '2025-01-05' }, ctxInr());
    expect(ie.xirr.state).toBe('not_applicable');
    expect('value' in ie.xirr).toBe(false);
    expect(ie.xirr.state === 'not_applicable' && ie.xirr.reason).toBe('xirr_unavailable');
  });

  it('NC-I1: flipping the purchase sign (money coming IN counted positive) leaves no root: no figure', () => {
    const flipped = FLOWS.map((f) => ({ ...f, amount: -f.amount }));
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: flipped, valuation: valuation(), asOfDate: '2025-01-05' }, ctxInr());
    // with the sign flipped the redemption is negative and everything else positive: a real root does not exist
    expect(ie.xirr.state).not.toBe('available');
  });

  it('a holding with no purchase has no invested amount and no gain figure', () => {
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: [], valuation: valuation(), asOfDate: '2025-01-05' }, ctxInr());
    expect(ie.investedAmount.state).toBe('insufficient_history');
    expect(ie.gainLoss.state).toBe('insufficient_history');
    expect(ie.xirr.state).not.toBe('available');
  });
});

describe('Fixture G (pure parts) -- valuation labels, redeemed, joint attribution', () => {
  it('spec example 2: 100 units, statement NAV 100 (Rs 10,000), latest eligible NAV 112 -> Rs 11,200 with its NAV date; a correction to 111 -> Rs 11,100; the statement value stays separate (matrix 32)', () => {
    const statements = [{ asOfDate: '2026-09-01', units: 100, value: 10000 }];
    const before = valueHoldingAsOf({ statements, navs: [{ date: '2026-09-01', price: 100 }, { date: '2026-10-01', price: 112 }], asOfDate: '2026-10-02' });
    expect(before).toMatchObject({ basis: 'market_nav', units: 100, marketValue: 11200, navDate: '2026-10-01', statementValue: 10000, statementAsOfDate: '2026-09-01', statementSuperseded: true });
    const after = valueHoldingAsOf({ statements, navs: [{ date: '2026-09-01', price: 100 }, { date: '2026-10-01', price: 111 }], asOfDate: '2026-10-02' });
    expect(after).toMatchObject({ basis: 'market_nav', marketValue: 11100, navDate: '2026-10-01', statementValue: 10000 });
    expect(statements).toHaveLength(1); // one canonical record throughout
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: [{ date: utc('2026-09-01'), amount: -10000 }], valuation: after, asOfDate: '2026-10-02' }, ctxInr());
    if (ie.currentValue.state !== 'available') throw new Error(ie.currentValue.state);
    expect(ie.currentValue.value.value).toBe(11100);
    expect(ie.currentValue.value.statementValue).toBe(10000); // labelled separately
  });

  it('NC-I4 / matrix 33: a redeemed holding is exactly zero, whatever NAV exists; the statement value is not shown as market value', () => {
    const redeemed = valueHoldingAsOf({ statements: [{ asOfDate: '2026-09-01', units: 0, value: 0 }], navs: [{ date: '2026-10-01', price: 500 }], asOfDate: '2026-10-02' });
    expect(redeemed.basis).toBe('redeemed');
    expect(redeemed.marketValue).toBe(0);
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: [], valuation: redeemed, asOfDate: '2026-10-02' }, ctxInr());
    if (ie.currentValue.state !== 'available') throw new Error(ie.currentValue.state);
    expect(ie.currentValue.value).toMatchObject({ value: 0, basis: 'redeemed' });
  });

  it('a statement-only valuation is labelled as a statement value (disclosure), never as a market NAV', () => {
    const stmt = valueHoldingAsOf({ statements: [{ asOfDate: '2026-09-01', units: 100, value: 10000 }], navs: [], asOfDate: '2026-09-02' });
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: [{ date: utc('2025-01-01'), amount: -8000 }], valuation: stmt, asOfDate: '2026-09-02' }, ctxInr());
    if (ie.currentValue.state !== 'available') throw new Error(ie.currentValue.state);
    expect(ie.currentValue.value.basis).toBe('statement');
    expect(ie.currentValue.disclosures.map((d) => d.code)).toContain('statement_value');
    expect(ie.currentValue.disclosures.find((d) => d.code === 'statement_value')?.detail).toContain('01-09-2026');
    const aud = computeInvestorExperience({ instrumentId: 'x', flows: [], valuation: stmt, asOfDate: '2026-09-02' }, ctxAud());
    expect(aud.currentValue.disclosures.find((d) => d.code === 'statement_value')?.detail).toContain('01/09/2026');
  });

  it('NC-I5 / matrix 34: a Rs 10,00,000 joint holding at 60 / 40 is Rs 6,00,000 + Rs 4,00,000 = Rs 10,00,000 once, never Rs 20,00,000 (spec example 4)', () => {
    const split = attributeByBasisPoints(1_000_000, [{ key: 'member-a', basisPoints: 6000 }, { key: 'member-b', basisPoints: 4000 }]);
    expect(split?.map((s) => [s.key, s.amount])).toEqual([['member-a', 600000], ['member-b', 400000]]);
    expect(split?.reduce((t, s) => t + s.amount, 0)).toBe(1_000_000);
    expect(split?.reduce((t, s) => t + s.basisPoints, 0)).toBe(10000);
    // an invalid split (150%) is refused, never double-counted
    expect(attributeByBasisPoints(1_000_000, [{ key: 'a', basisPoints: 6000 }, { key: 'b', basisPoints: 9000 }])).toBeNull();
  });

  it('every sentence in the investor family is day-first with no ISO date', () => {
    const stmt = valueHoldingAsOf({ statements: [{ asOfDate: '2026-09-01', units: 100, value: 10000 }], navs: [], asOfDate: '2026-09-02' });
    const ie = computeInvestorExperience({ instrumentId: 'x', flows: [{ date: utc('2025-01-01'), amount: -8000 }], valuation: stmt, asOfDate: '2026-09-02' }, ctxInr());
    const texts = [ie.xirr, ie.currentValue, ie.investedAmount, ie.gainLoss].flatMap((r) => [...r.disclosures.map((d) => d.detail), ...(r.state === 'available' ? [] : [r.detail])]);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of allStrings(texts)) expect(t, t).not.toMatch(ISO_DATE_IN_TEXT);
  });
});
