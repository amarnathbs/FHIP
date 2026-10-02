// Document2 Finding #5 ("Current NAV / holding value") — the pure valuation
// rule, proven with hand-computed values AND with named negative controls.
//
// HOW THE NEGATIVE CONTROLS WORK (and why they are real)
// ------------------------------------------------------
// Every rule below is written ONCE as a check function `ruleX(impl)` that
// throws a message naming the rule when `impl` violates it. Each rule is then
// run twice:
//
//   1. against the REAL valueHoldingAsOf / selectLatestEligibleNav — must pass;
//   2. against a deliberately BROKEN implementation (a "mutant" that omits
//      exactly that rule) — must throw the rule's own named message.
//
// So a green run proves two things at once: the rule holds, and the assertion
// that guards it is demonstrably capable of failing when the rule is broken
// (a control that never failed would be indistinguishable from one that never
// applied). The failing assertion for each control is the `toThrow(/RULE-N/)`
// below, and the thrown text names the exact expectation that tripped.
//
// All dates and amounts are hand-computed in the comments; none is produced by
// the code under test.

import { describe, it, expect } from 'vitest';
import {
  NAV_STALE_AFTER_DAYS,
  selectLatestEligibleNav,
  selectStatementAsOf,
  valueHoldingAsOf,
  type HoldingValuation,
  type NavObservationRow,
  type StatementPositionInput,
} from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';

type ValueInput = Parameters<typeof valueHoldingAsOf>[0];
type Impl = (input: ValueInput) => HoldingValuation;

const real: Impl = valueHoldingAsOf;

function assertThat(rule: string, cond: boolean, detail: string): void {
  if (!cond) throw new Error(`${rule} violated: ${detail}`);
}

const stmt = (asOfDate: string, units: number, value: number, currencyCode = 'INR'): StatementPositionInput => ({ asOfDate, units, value, currencyCode });
const nav = (date: string, price: number, extra: Partial<NavObservationRow> = {}): NavObservationRow => ({ date, price, currencyCode: 'INR', qualityStatus: 'ok', ...extra });

// ---------------------------------------------------------------------------
// The rules. Each takes an implementation and throws a RULE-N message if broken.
// ---------------------------------------------------------------------------

// RULE-1: latest eligible NAV newer than the statement wins. 100 units,
// statement 2026-06-30 value 10000 (statement NAV 100). NAVs: 06-30 @100,
// 08-15 @110, 09-25 @120. Latest = 09-25 @120 -> 100 x 120 = 12000.
function rule1(impl: Impl): void {
  const v = impl({
    statements: [stmt('2026-06-30', 100, 10000)],
    navs: [nav('2026-06-30', 100), nav('2026-08-15', 110), nav('2026-09-25', 120)],
    asOfDate: '2026-09-28',
  });
  assertThat('RULE-1', v.marketValue === 12000, `expected market value 12000 (100 x 120), got ${v.marketValue}`);
  assertThat('RULE-1', v.nav === 120 && v.navDate === '2026-09-25', `expected NAV 120 dated 2026-09-25, got ${v.nav} dated ${v.navDate}`);
  assertThat('RULE-1', v.basis === 'market_nav' && v.navSource === 'market', `expected basis market_nav, got ${v.basis}`);
}

// RULE-2: a future-dated NAV never influences an earlier valuation. As at
// 2026-09-28 the 2026-10-05 @999 row is invisible; the 09-25 @120 row wins.
function rule2(impl: Impl): void {
  const v = impl({
    statements: [stmt('2026-06-30', 100, 10000)],
    navs: [nav('2026-09-25', 120), nav('2026-10-05', 999)],
    asOfDate: '2026-09-28',
  });
  assertThat('RULE-2', v.marketValue === 12000, `future-dated NAV leaked: expected 12000, got ${v.marketValue}`);
  assertThat('RULE-2', v.navDate === '2026-09-25', `expected NAV date 2026-09-25, got ${v.navDate}`);
}

// RULE-3: a historical (point-in-time) valuation uses the NAV AND the
// statement valid on that date, never today's. As at 2026-08-20: statement
// 2026-06-30 (100 units, 10000) is the latest at/before; NAVs at/before are
// 06-30 @100 and 08-15 @110 -> 100 x 110 = 11000. A later statement
// (2026-09-15, 120 units) and the 09-25 @120 NAV must be invisible.
function rule3(impl: Impl): void {
  const v = impl({
    statements: [stmt('2026-06-30', 100, 10000), stmt('2026-09-15', 120, 14000)],
    navs: [nav('2026-06-30', 100), nav('2026-08-15', 110), nav('2026-09-25', 120)],
    asOfDate: '2026-08-20',
    pointInTime: true,
  });
  assertThat('RULE-3', v.marketValue === 11000, `expected 11000 (100 units x 110 NAV on 2026-08-15), got ${v.marketValue}`);
  assertThat('RULE-3', v.navDate === '2026-08-15', `expected NAV date 2026-08-15, got ${v.navDate}`);
  assertThat('RULE-3', v.units === 100, `a statement dated after the as-of date leaked in: units ${v.units}`);
}

// RULE-4: a corrected NAV supersedes the prior value. The NAV table holds ONE
// row per (instrument, date) and a correction updates it in place (migration
// 0033 unique key; see GOLD-006), so the observable behaviour is: the
// corrected price is the one used, and if a duplicate same-date pair is ever
// presented, the LATER row (higher id) wins. 100 x 105 = 10500, not 100 x 98.
function rule4(impl: Impl): void {
  const v = impl({
    statements: [stmt('2026-06-30', 100, 10000)],
    navs: [nav('2026-09-20', 98), nav('2026-09-20', 105)],
    asOfDate: '2026-09-28',
  });
  assertThat('RULE-4', v.marketValue === 10500, `expected the corrected 105 to supersede 98 (10500), got ${v.marketValue}`);
}

// RULE-5: the statement NAV is not the current NAV when a newer valid NAV
// exists. Statement 2026-06-30 implies NAV 100; a 2026-09-25 NAV of 120 is
// newer. The displayed NAV must be 120 dated 09-25, the statement NAV kept
// only as evidence and flagged superseded.
function rule5(impl: Impl): void {
  const v = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-25', 120)], asOfDate: '2026-09-28' });
  assertThat('RULE-5', v.nav === 120 && v.navDate === '2026-09-25', `statement NAV masquerades as current: nav ${v.nav} dated ${v.navDate}`);
  assertThat('RULE-5', v.statementNav === 100 && v.statementAsOfDate === '2026-06-30', `statement evidence lost: ${v.statementNav} / ${v.statementAsOfDate}`);
  assertThat('RULE-5', v.statementSuperseded === true, 'statement NAV not flagged superseded');
}

// RULE-6: with no market NAV newer than the statement, the statement value is
// used AND LABELLED as a statement value (never as a market NAV).
function rule6(impl: Impl): void {
  const v = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [], asOfDate: '2026-07-02' });
  assertThat('RULE-6', v.marketValue === 10000 && v.nav === 100 && v.navDate === '2026-06-30', `expected statement value 10000 / NAV 100 / 2026-06-30, got ${v.marketValue} / ${v.nav} / ${v.navDate}`);
  assertThat('RULE-6', v.basis === 'statement' && v.navSource === 'statement', `statement value not labelled as such: basis ${v.basis}, source ${v.navSource}`);
  assertThat('RULE-6', v.statementSuperseded === false, 'statement flagged superseded with no newer NAV');
  // A NAV OLDER than the statement must not displace it either.
  const w = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-05-01', 90)], asOfDate: '2026-07-02' });
  assertThat('RULE-6', w.basis === 'statement' && w.marketValue === 10000, `an older NAV displaced the statement: ${w.basis} ${w.marketValue}`);
}

// RULE-7: a fully redeemed holding (0 units) is exactly 0 without needing any
// NAV; a missing, stale or future NAV can neither block nor change it.
function rule7(impl: Impl): void {
  const noNav = impl({ statements: [stmt('2026-07-20', 0, 0)], navs: [], asOfDate: '2026-09-28' });
  assertThat('RULE-7', noNav.marketValue === 0, `redeemed holding with no NAV must be exactly 0, got ${noNav.marketValue}`);
  assertThat('RULE-7', noNav.basis === 'redeemed', `expected basis redeemed, got ${noNav.basis}`);
  const withNav = impl({ statements: [stmt('2026-07-20', 0, 0)], navs: [nav('2026-08-29', 15)], asOfDate: '2026-09-28' });
  assertThat('RULE-7', withNav.marketValue === 0, `a later NAV resurrected a redeemed holding: ${withNav.marketValue}`);
}

// RULE-8: a NAV in a different currency is never applied to the holding.
// INR holding, only NAV is AUD 50 -> not eligible -> statement value stays.
function rule8(impl: Impl): void {
  const v = impl({
    statements: [stmt('2026-06-30', 100, 10000, 'INR')],
    navs: [nav('2026-09-25', 50, { currencyCode: 'AUD' })],
    asOfDate: '2026-09-28',
  });
  assertThat('RULE-8', v.basis === 'statement' && v.marketValue === 10000, `an AUD NAV was applied to an INR holding: basis ${v.basis}, value ${v.marketValue}`);
}

// RULE-9: staleness is disclosed, not hidden. Statement-basis valuation as at
// 2026-09-28 from a 2026-06-30 statement is 90 days old (> 7).
function rule9(impl: Impl): void {
  const old = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [], asOfDate: '2026-09-28' });
  assertThat('RULE-9', old.stale === true && old.ageDays === 90, `expected stale with ageDays 90, got stale=${old.stale} ageDays=${old.ageDays}`);
  assertThat('RULE-9', /may be out of date/.test(old.note), `stale note missing: "${old.note}"`);
  const fresh = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-25', 120)], asOfDate: '2026-09-28' });
  assertThat('RULE-9', fresh.stale === false && fresh.ageDays === 3, `a 3-day-old NAV must not be stale: stale=${fresh.stale} ageDays=${fresh.ageDays}`);
}

// RULE-10: a flagged NAV (stale / suspicious_jump / superseded) is never used,
// and a zero or negative price is a data fault, never a "value of zero".
function rule10(impl: Impl): void {
  const flagged = impl({
    statements: [stmt('2026-06-30', 100, 10000)],
    navs: [nav('2026-09-20', 110), nav('2026-09-25', 500, { qualityStatus: 'suspicious_jump' }), nav('2026-09-26', 400, { qualityStatus: 'superseded' })],
    asOfDate: '2026-09-28',
  });
  assertThat('RULE-10', flagged.marketValue === 11000 && flagged.navDate === '2026-09-20', `a flagged NAV was used: ${flagged.marketValue} dated ${flagged.navDate}`);
  const zero = impl({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-25', 0)], asOfDate: '2026-09-28' });
  assertThat('RULE-10', zero.marketValue === 10000 && zero.basis === 'statement', `a zero price produced a fake zero value: ${zero.marketValue} (${zero.basis})`);
}

// RULE-11: no statement -> unavailable (null), never a fabricated zero.
function rule11(impl: Impl): void {
  const v = impl({ statements: [], navs: [nav('2026-09-25', 120)], asOfDate: '2026-09-28' });
  assertThat('RULE-11', v.marketValue === null && v.basis === 'unavailable', `expected unavailable/null, got ${v.marketValue} (${v.basis})`);
}

// ---------------------------------------------------------------------------
// Mutants: each omits exactly one rule.
// ---------------------------------------------------------------------------

// The OLD behaviour of the Holdings/X-Ray/Overview consumers: statement value
// and statement date, always.
const mutantStatementOnly: Impl = (input) => {
  const s = [...input.statements].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).filter((x) => !input.pointInTime || x.asOfDate <= input.asOfDate).pop();
  if (!s) return { ...real({ ...input, statements: [] }) };
  const base = real({ ...input, navs: [] });
  return { ...base, marketValue: s.value, nav: s.units > 0 ? s.value / s.units : null, navDate: s.asOfDate };
};

// Takes the chronologically last NAV with no regard to the valuation date.
const mutantNoDateBound: Impl = (input) => {
  const base = real({ ...input, navs: [] });
  const last = [...input.navs].sort((a, b) => a.date.localeCompare(b.date)).pop();
  const s = input.statements[input.statements.length - 1];
  if (!last || !s || last.date <= s.asOfDate) return real(input);
  return { ...base, basis: 'market_nav', navSource: 'market', marketValue: s.units * last.price, nav: last.price, navDate: last.date, statementSuperseded: true };
};

// Ignores pointInTime: always the latest statement.
const mutantIgnoresPointInTime: Impl = (input) => real({ ...input, pointInTime: false });

// Same-date duplicates: FIRST wins instead of the later (corrected) row.
const mutantFirstWinsOnTie: Impl = (input) => {
  const seen = new Set<string>();
  const dedup = input.navs.filter((n) => (seen.has(n.date) ? false : (seen.add(n.date), true)));
  return real({ ...input, navs: dedup });
};

// Statement NAV shown as the current market NAV (labels it market, hides the supersession).
const mutantStatementAsCurrent: Impl = (input) => {
  const v = real(input);
  const s = [...input.statements].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).pop();
  if (!s || v.basis === 'redeemed' || v.basis === 'unavailable') return v;
  return { ...v, nav: s.units > 0 ? s.value / s.units : null, navDate: s.asOfDate, statementSuperseded: false };
};

// Labels a statement-basis value as a market NAV.
const mutantStatementLabelledMarket: Impl = (input) => {
  const v = real(input);
  return v.basis === 'statement' ? { ...v, basis: 'market_nav', navSource: 'market' } : v;
};

// Needs a NAV to value anything: a missing NAV blanks even a redeemed holding.
const mutantNeedsNav: Impl = (input) => {
  const v = real(input);
  return v.basis === 'redeemed' && input.navs.length === 0 ? { ...v, marketValue: null, basis: 'unavailable' } : v;
};

// A later NAV is multiplied through even when units are 0 against the statement value (resurrection).
const mutantRedeemedResurrected: Impl = (input) => {
  const v = real(input);
  if (v.basis !== 'redeemed' || input.navs.length === 0) return v;
  const lastNav = [...input.navs].sort((a, b) => a.date.localeCompare(b.date)).pop()!;
  return { ...v, marketValue: v.statementValue === 0 ? lastNav.price : v.marketValue };
};

// No currency eligibility.
const mutantNoCurrencyGuard: Impl = (input) => real({ ...input, navs: input.navs.map((n) => ({ ...n, currencyCode: null })) });

// Never discloses staleness.
const mutantNoStaleDisclosure: Impl = (input) => ({ ...real(input), stale: false, note: 'Valued at the latest NAV on file.' });

// No quality / price validity eligibility.
const mutantNoQualityGuard: Impl = (input) => real({ ...input, navs: input.navs.map((n) => ({ ...n, qualityStatus: 'ok' })) });
const mutantZeroPriceAccepted: Impl = (input) => {
  // Treat a zero price as a real price by nudging it above the validity floor.
  return real({ ...input, navs: input.navs.map((n) => (n.price === 0 ? { ...n, price: 1e-12 } : n)) });
};

// Fabricates 0 when no statement exists.
const mutantFakeZero: Impl = (input) => {
  const v = real(input);
  return v.basis === 'unavailable' ? { ...v, marketValue: 0 } : v;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Finding #5 valuation rule — the real implementation satisfies every rule', () => {
  it('RULE-1 latest eligible NAV is used (100 x 120 = 12000, dated 2026-09-25)', () => rule1(real));
  it('RULE-2 a future-dated NAV is ignored', () => rule2(real));
  it('RULE-3 a historical valuation uses the NAV and statement valid on that date (11000 on 2026-08-15 NAV)', () => rule3(real));
  it('RULE-4 a corrected NAV supersedes the prior value (10500, not 9800)', () => rule4(real));
  it('RULE-5 the statement NAV is not the current NAV once a newer valid NAV exists', () => rule5(real));
  it('RULE-6 with no newer NAV the statement value is used and labelled as a statement value', () => rule6(real));
  it('RULE-7 a redeemed holding is 0 with or without a NAV', () => rule7(real));
  it('RULE-8 a NAV in a different currency is never applied', () => rule8(real));
  it('RULE-9 staleness is disclosed (90 days stale, 3 days not stale)', () => rule9(real));
  it('RULE-10 flagged or non-positive NAVs are never used', () => rule10(real));
  it('RULE-11 no statement is unavailable, never a fabricated zero', () => rule11(real));
});

describe('Finding #5 valuation rule — NEGATIVE CONTROLS (each broken variant must trip its named rule)', () => {
  it('statement-only valuation (the pre-fix Holdings/X-Ray/Overview behaviour) fails RULE-1 and RULE-5', () => {
    expect(() => rule1(mutantStatementOnly)).toThrow(/RULE-1 violated: expected market value 12000/);
    expect(() => rule5(mutantStatementOnly)).toThrow(/RULE-5 violated/);
  });
  it('a valuation with no date bound fails RULE-2 (future NAV leaks)', () => {
    expect(() => rule2(mutantNoDateBound)).toThrow(/RULE-2 violated: future-dated NAV leaked/);
  });
  it('a valuation that ignores point-in-time fails RULE-3', () => {
    expect(() => rule3(mutantIgnoresPointInTime)).toThrow(/RULE-3 violated/);
  });
  it('first-wins on a same-date duplicate fails RULE-4 (correction would not supersede)', () => {
    expect(() => rule4(mutantFirstWinsOnTie)).toThrow(/RULE-4 violated: expected the corrected 105/);
  });
  it('showing the statement NAV as current fails RULE-5', () => {
    expect(() => rule5(mutantStatementAsCurrent)).toThrow(/RULE-5 violated: statement NAV masquerades as current/);
  });
  it('labelling a statement value as a market NAV fails RULE-6', () => {
    expect(() => rule6(mutantStatementLabelledMarket)).toThrow(/RULE-6 violated: statement value not labelled as such/);
  });
  it('requiring a NAV for a redeemed holding fails RULE-7', () => {
    expect(() => rule7(mutantNeedsNav)).toThrow(/RULE-7 violated: redeemed holding with no NAV must be exactly 0/);
  });
  it('multiplying a later NAV into a redeemed holding fails RULE-7 (resurrection)', () => {
    expect(() => rule7(mutantRedeemedResurrected)).toThrow(/RULE-7 violated: a later NAV resurrected/);
  });
  it('no currency guard fails RULE-8 (AUD NAV applied to INR holding)', () => {
    expect(() => rule8(mutantNoCurrencyGuard)).toThrow(/RULE-8 violated: an AUD NAV was applied to an INR holding/);
  });
  it('no stale disclosure fails RULE-9', () => {
    expect(() => rule9(mutantNoStaleDisclosure)).toThrow(/RULE-9 violated: expected stale with ageDays 90/);
  });
  it('no quality guard fails RULE-10 (flagged NAV used)', () => {
    expect(() => rule10(mutantNoQualityGuard)).toThrow(/RULE-10 violated: a flagged NAV was used/);
  });
  it('accepting a zero price fails RULE-10 (fake zero)', () => {
    expect(() => rule10(mutantZeroPriceAccepted)).toThrow(/RULE-10 violated/);
  });
  it('fabricating 0 for a missing statement fails RULE-11', () => {
    expect(() => rule11(mutantFakeZero)).toThrow(/RULE-11 violated: expected unavailable\/null/);
  });
});

describe('Finding #5 valuation rule — selection helpers and boundaries', () => {
  it('selectLatestEligibleNav reports exactly why each row was excluded', () => {
    const sel = selectLatestEligibleNav(
      [
        nav('2026-09-20', 110), // eligible
        nav('2026-09-21', 111, { qualityStatus: 'stale' }), // quality
        nav('2026-09-22', 0), // invalid price
        nav('2026-09-23', 50, { currencyCode: 'AUD' }), // currency
        nav('2026-10-05', 999), // future
      ],
      { asOfDate: '2026-09-28', currencyCode: 'INR' }
    );
    expect(sel.nav?.price).toBe(110);
    expect(sel.nav?.date).toBe('2026-09-20');
    expect(sel.excluded).toEqual({ future_dated: 1, quality_not_ok: 1, currency_mismatch: 1, invalid_price: 1 });
  });

  it('a NAV dated exactly on the valuation date is eligible; the day after is not', () => {
    expect(selectLatestEligibleNav([nav('2026-09-28', 120)], { asOfDate: '2026-09-28' }).nav?.price).toBe(120);
    expect(selectLatestEligibleNav([nav('2026-09-29', 120)], { asOfDate: '2026-09-28' }).nav).toBeNull();
  });

  it('a NAV dated on the statement date does NOT supersede it (strictly newer only); the statement value is kept', () => {
    const v = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-06-30', 101)], asOfDate: '2026-07-01' });
    expect(v.basis).toBe('statement');
    expect(v.marketValue).toBe(10000);
  });

  it('currency matching is case-insensitive and a NAV with no stated currency is accepted (legacy rows)', () => {
    const v = valueHoldingAsOf({
      statements: [stmt('2026-06-30', 100, 10000, 'inr')],
      navs: [nav('2026-09-25', 120, { currencyCode: null })],
      asOfDate: '2026-09-28',
    });
    expect(v.marketValue).toBe(12000);
  });

  it('the stale threshold is exactly NAV_STALE_AFTER_DAYS: 7 days is current, 8 is stale', () => {
    expect(NAV_STALE_AFTER_DAYS).toBe(7);
    const at7 = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-21', 120)], asOfDate: '2026-09-28' });
    const at8 = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-20', 120)], asOfDate: '2026-09-28' });
    expect(at7.ageDays).toBe(7);
    expect(at7.stale).toBe(false);
    expect(at8.ageDays).toBe(8);
    expect(at8.stale).toBe(true);
  });

  it('in the default CURRENT view a statement dated one day ahead of UTC "today" is kept, not hidden (IST/AEST evening)', () => {
    const v = valueHoldingAsOf({ statements: [stmt('2026-09-29', 100, 12500)], navs: [], asOfDate: '2026-09-28' });
    expect(v.basis).toBe('statement');
    expect(v.marketValue).toBe(12500);
    expect(v.ageDays).toBe(0); // never negative
    const pit = valueHoldingAsOf({ statements: [stmt('2026-09-29', 100, 12500)], navs: [], asOfDate: '2026-09-28', pointInTime: true });
    expect(pit.basis).toBe('unavailable');
  });

  it('selectStatementAsOf: latest at-or-before in point-in-time mode, latest overall otherwise', () => {
    const list = [stmt('2026-01-31', 10, 1000), stmt('2026-06-30', 20, 2400), stmt('2026-09-30', 30, 3900)];
    expect(selectStatementAsOf(list, '2026-07-15', true)?.units).toBe(20);
    expect(selectStatementAsOf(list, '2026-07-15', false)?.units).toBe(30);
    expect(selectStatementAsOf(list, '2025-12-31', true)).toBeNull();
  });

  it('a partial redemption keeps its remaining units and is valued at the latest NAV (60 units x 130 = 7800)', () => {
    const v = valueHoldingAsOf({ statements: [stmt('2026-07-20', 60, 6600)], navs: [nav('2026-09-25', 130)], asOfDate: '2026-09-28' });
    expect(v.marketValue).toBe(7800);
    expect(v.units).toBe(60);
    expect(v.basis).toBe('market_nav');
  });
});
